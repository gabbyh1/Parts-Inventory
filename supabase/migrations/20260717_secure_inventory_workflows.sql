begin;

create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;

create table if not exists private.inventory_staff_credentials (
  id smallint primary key default 1 check (id = 1),
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists private.inventory_staff_sessions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  operator_name text
);

alter table private.inventory_staff_sessions
  add column if not exists operator_name text;

create index if not exists inventory_staff_sessions_active_idx
  on private.inventory_staff_sessions (token_hash, expires_at)
  where revoked_at is null;

create table if not exists private.inventory_login_attempts (
  client_key text not null,
  attempted_at timestamptz not null default now(),
  success boolean not null default false
);

create index if not exists inventory_login_attempts_lookup_idx
  on private.inventory_login_attempts (client_key, attempted_at desc);

create or replace function private.inventory_request_headers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
exception when others then
  return '{}'::jsonb;
end;
$$;

create or replace function private.inventory_client_key(p_prefix text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      coalesce(p_prefix, 'inventory') || ':' || coalesce(
        private.inventory_request_headers()->>'cf-connecting-ip',
        split_part(private.inventory_request_headers()->>'x-forwarded-for', ',', 1),
        private.inventory_request_headers()->>'x-real-ip',
        'unknown'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function private.inventory_session_token()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(private.inventory_request_headers()->>'x-inventory-session', '');
$$;

create or replace function private.has_valid_inventory_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.inventory_staff_sessions session
    where session.token_hash = pg_catalog.encode(
      extensions.digest(coalesce(private.inventory_session_token(), ''), 'sha256'),
      'hex'
    )
      and session.revoked_at is null
      and session.expires_at > now()
  );
$$;

create or replace function public.set_inventory_staff_password(p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(coalesce(p_password, '')) < 6 or char_length(p_password) > 200 then
    raise exception 'Password must contain between 6 and 200 characters.' using errcode = '22023';
  end if;

  insert into private.inventory_staff_credentials (id, password_hash, updated_at)
  values (1, extensions.crypt(p_password, extensions.gen_salt('bf', 12)), now())
  on conflict (id) do update
  set password_hash = excluded.password_hash,
      updated_at = excluded.updated_at;

  update private.inventory_staff_sessions
  set revoked_at = now()
  where revoked_at is null;
end;
$$;

drop function if exists public.authenticate_inventory_staff(text, text);

create or replace function public.authenticate_inventory_staff(p_password text)
returns table (session_token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client_key text := private.inventory_client_key('login-client');
  v_failures integer;
  v_password_hash text;
  v_token text;
  v_expires_at timestamptz := now() + interval '8 hours';
begin
  delete from private.inventory_login_attempts attempt
  where attempt.attempted_at < now() - interval '1 day';

  select count(*) into v_failures
  from private.inventory_login_attempts attempt
  where attempt.client_key = v_client_key
    and attempt.success = false
    and attempt.attempted_at > now() - interval '15 minutes';

  if v_failures >= 10 then
    raise exception 'Too many failed attempts. Please wait 15 minutes and try again.' using errcode = 'P0001';
  end if;

  if p_password is null or char_length(p_password) = 0 or char_length(p_password) > 200 then
    insert into private.inventory_login_attempts (client_key, success) values (v_client_key, false);
    return;
  end if;

  select credential.password_hash into v_password_hash
  from private.inventory_staff_credentials credential
  where credential.id = 1;

  if v_password_hash is null then
    perform extensions.crypt(p_password, extensions.gen_salt('bf', 10));
    raise exception 'Inventory authentication is not configured.' using errcode = 'P0001';
  end if;

  if extensions.crypt(p_password, v_password_hash) <> v_password_hash then
    insert into private.inventory_login_attempts (client_key, success) values (v_client_key, false);
    return;
  end if;

  delete from private.inventory_login_attempts attempt
  where attempt.client_key = v_client_key and attempt.success = false;

  insert into private.inventory_login_attempts (client_key, success) values (v_client_key, true);

  delete from private.inventory_staff_sessions session
  where session.expires_at < now() - interval '1 day'
     or session.revoked_at < now() - interval '1 day';

  v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');

  insert into private.inventory_staff_sessions (token_hash, expires_at, operator_name)
  values (
    pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_expires_at,
    'Staff'
  );

  return query select v_token, v_expires_at;
end;
$$;

create or replace function public.validate_inventory_staff_session()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_valid_inventory_session() then
    return false;
  end if;

  update private.inventory_staff_sessions session
  set last_seen_at = now()
  where session.token_hash = pg_catalog.encode(
    extensions.digest(private.inventory_session_token(), 'sha256'),
    'hex'
  );

  return true;
end;
$$;

create or replace function public.end_inventory_staff_session()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.inventory_staff_sessions session
  set revoked_at = now()
  where session.token_hash = pg_catalog.encode(
    extensions.digest(coalesce(private.inventory_session_token(), ''), 'sha256'),
    'hex'
  ) and session.revoked_at is null;
end;
$$;

create or replace function public.inventory_adjust_stock(
  p_part_id bigint,
  p_delta bigint,
  p_movement_type text,
  p_job_number text default '',
  p_notes text default ''
)
returns table (new_quantity bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_part public."Parts"%rowtype;
  v_new_quantity bigint;
begin
  if not private.has_valid_inventory_session() then
    raise exception 'A valid inventory session is required.' using errcode = '42501';
  end if;

  if p_part_id is null or p_delta is null or p_delta = 0
    or char_length(btrim(coalesce(p_movement_type, ''))) not between 1 and 50
    or char_length(coalesce(p_job_number, '')) > 100
    or char_length(coalesce(p_notes, '')) > 1000 then
    raise exception 'Invalid stock movement.' using errcode = '22023';
  end if;

  select * into v_part
  from public."Parts"
  where id = p_part_id
  for update;

  if not found then
    raise exception 'Part not found.' using errcode = 'P0002';
  end if;

  v_new_quantity := coalesce(v_part."Quantity", 0) + p_delta;
  if v_new_quantity < 0 then
    raise exception 'Insufficient stock.' using errcode = '22023';
  end if;

  update public."Parts"
  set "Quantity" = v_new_quantity
  where id = p_part_id;

  insert into public.stock_movements (
    part_id,
    part_name,
    manufacturer_part_number,
    movement_type,
    quantity,
    job_number,
    notes
  ) values (
    v_part.id,
    coalesce(v_part."Part Name", ''),
    coalesce(v_part."Manufacturer Part Number", ''),
    btrim(p_movement_type),
    abs(p_delta),
    btrim(coalesce(p_job_number, '')),
    btrim(coalesce(p_notes, ''))
  );

  return query select v_new_quantity;
end;
$$;

create or replace function public.inventory_bulk_issue(
  p_job_number text,
  p_notes text,
  p_items jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_part public."Parts"%rowtype;
  v_part_id bigint;
  v_quantity bigint;
  v_count integer;
begin
  if not private.has_valid_inventory_session() then
    raise exception 'A valid inventory session is required.' using errcode = '42501';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Bulk issue items must be an array.' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_items);
  if char_length(btrim(coalesce(p_job_number, ''))) not between 1 and 100
    or char_length(coalesce(p_notes, '')) > 1000
    or v_count not between 1 and 100 then
    raise exception 'Invalid bulk issue.' using errcode = '22023';
  end if;

  if (
    select count(distinct (value->>'part_id')::bigint)
    from jsonb_array_elements(p_items) as items(value)
  ) <> v_count then
    raise exception 'Each part may only appear once in a bulk issue.' using errcode = '22023';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_items) as items(value)
    order by (value->>'part_id')::bigint
  loop
    begin
      v_part_id := (v_item->>'part_id')::bigint;
      v_quantity := (v_item->>'quantity')::bigint;
    exception when others then
      raise exception 'Every bulk item requires a valid part ID and quantity.' using errcode = '22023';
    end;

    if v_part_id is null or v_quantity is null or v_quantity < 1 then
      raise exception 'Bulk quantities must be greater than zero.' using errcode = '22023';
    end if;

    select * into v_part
    from public."Parts"
    where id = v_part_id
    for update;

    if not found then
      raise exception 'Part % was not found.', v_part_id using errcode = 'P0002';
    end if;

    if coalesce(v_part."Quantity", 0) < v_quantity then
      raise exception 'Insufficient stock for %.', coalesce(v_part."Part Name", 'part') using errcode = '22023';
    end if;

    update public."Parts"
    set "Quantity" = coalesce(v_part."Quantity", 0) - v_quantity
    where id = v_part_id;

    insert into public.stock_movements (
      part_id,
      part_name,
      manufacturer_part_number,
      movement_type,
      quantity,
      job_number,
      notes
    ) values (
      v_part.id,
      coalesce(v_part."Part Name", ''),
      coalesce(v_part."Manufacturer Part Number", ''),
      'JOB OUT',
      v_quantity,
      btrim(p_job_number),
      btrim(coalesce(p_notes, ''))
    );
  end loop;

  return true;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'parts_quantity_nonnegative') then
    alter table public."Parts"
      add constraint parts_quantity_nonnegative
      check ("Quantity" is not null and "Quantity" >= 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'parts_name_required') then
    alter table public."Parts"
      add constraint parts_name_required
      check (char_length(btrim(coalesce("Part Name", ''))) between 1 and 200) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'parts_text_lengths') then
    alter table public."Parts"
      add constraint parts_text_lengths
      check (
        char_length(coalesce("Supplier Name", '')) <= 200
        and char_length(coalesce("Manufacturer Part Number", '')) <= 200
        and char_length(coalesce("Part Type", '')) <= 100
        and char_length(coalesce("Description", '')) <= 2000
        and char_length(coalesce("Rack", '')) <= 100
        and char_length(coalesce("Drawer", '')) <= 100
        and char_length(coalesce("Area", '')) <= 500
      ) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'parts_shelf_nonnegative') then
    alter table public."Parts"
      add constraint parts_shelf_nonnegative
      check ("Shelf" is null or "Shelf" >= 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'warning_level_nonnegative') then
    alter table public.stock_warning_rules
      add constraint warning_level_nonnegative
      check (warning_level is not null and warning_level >= 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'warning_part_type_required') then
    alter table public.stock_warning_rules
      add constraint warning_part_type_required
      check (char_length(btrim(coalesce(part_type, ''))) between 1 and 100) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'movement_quantity_positive') then
    alter table public.stock_movements
      add constraint movement_quantity_positive
      check (quantity is not null and quantity > 0) not valid;
  end if;
end;
$$;

do $$
declare
  v_table text;
  v_policy record;
begin
  foreach v_table in array array['Parts', 'stock_movements', 'stock_warning_rules'] loop
    if to_regclass('public.' || quote_ident(v_table)) is null then
      raise exception 'Required table public.% does not exist.', v_table;
    end if;

    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all privileges on table public.%I from anon, authenticated', v_table);

    for v_policy in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = v_table
    loop
      execute format('drop policy %I on public.%I', v_policy.policyname, v_table);
    end loop;
  end loop;
end;
$$;

grant select, insert, delete on public."Parts" to anon;
grant update (
  "Part Name",
  "Supplier Name",
  "Manufacturer Part Number",
  "Part Type",
  "Description",
  "Rack",
  "Shelf",
  "Drawer",
  "Area",
  "Notes"
) on public."Parts" to anon;
grant select on public.stock_movements to anon;
grant select, insert, update, delete on public.stock_warning_rules to anon;

do $$
declare
  v_sequence text;
begin
  v_sequence := pg_get_serial_sequence('public."Parts"', 'id');
  if v_sequence is not null then
    execute format('grant usage, select on sequence %s to anon', v_sequence);
  end if;

  v_sequence := pg_get_serial_sequence('public.stock_warning_rules', 'id');
  if v_sequence is not null then
    execute format('grant usage, select on sequence %s to anon', v_sequence);
  end if;
end;
$$;

create policy inventory_staff_parts_access
  on public."Parts" for all to anon
  using ((select private.has_valid_inventory_session()))
  with check ((select private.has_valid_inventory_session()));

create policy inventory_staff_movement_read
  on public.stock_movements for select to anon
  using ((select private.has_valid_inventory_session()));

create policy inventory_staff_warning_access
  on public.stock_warning_rules for all to anon
  using ((select private.has_valid_inventory_session()))
  with check ((select private.has_valid_inventory_session()));

alter view public.parts_public set (security_invoker = true);
revoke all on public.parts_public from anon, authenticated;
grant select on public.parts_public to anon;

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to anon;
grant execute on function private.has_valid_inventory_session() to anon;

revoke all on function public.set_inventory_staff_password(text) from public, anon, authenticated;
revoke all on function public.authenticate_inventory_staff(text) from public, anon, authenticated;
revoke all on function public.validate_inventory_staff_session() from public, anon, authenticated;
revoke all on function public.end_inventory_staff_session() from public, anon, authenticated;
revoke all on function public.inventory_adjust_stock(bigint, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.inventory_bulk_issue(text, text, jsonb) from public, anon, authenticated;

grant execute on function public.set_inventory_staff_password(text) to service_role;
grant execute on function public.authenticate_inventory_staff(text) to anon;
grant execute on function public.validate_inventory_staff_session() to anon;
grant execute on function public.end_inventory_staff_session() to anon;
grant execute on function public.inventory_adjust_stock(bigint, bigint, text, text, text) to anon;
grant execute on function public.inventory_bulk_issue(text, text, jsonb) to anon;

notify pgrst, 'reload schema';

commit;

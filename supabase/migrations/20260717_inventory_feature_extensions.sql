begin;

alter table public."Parts"
  add column if not exists manually_low boolean not null default false,
  add column if not exists reorder_quantity bigint,
  add column if not exists supplier_url text,
  add column if not exists datasheet_url text,
  add column if not exists image_url text,
  add column if not exists purchase_price numeric(12,2),
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

alter table public.stock_movements
  add column if not exists performed_by text,
  add column if not exists reversed_movement_id bigint,
  add column if not exists reversal_reason text;

create index if not exists stock_movements_reversed_movement_idx
  on public.stock_movements (reversed_movement_id)
  where reversed_movement_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'parts_reorder_quantity_nonnegative' and conrelid = 'public."Parts"'::regclass) then
    alter table public."Parts"
      add constraint parts_reorder_quantity_nonnegative
      check (reorder_quantity is null or reorder_quantity >= 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'parts_purchase_price_nonnegative' and conrelid = 'public."Parts"'::regclass) then
    alter table public."Parts"
      add constraint parts_purchase_price_nonnegative
      check (purchase_price is null or purchase_price >= 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_movements_reversed_movement_fk' and conrelid = 'public.stock_movements'::regclass) then
    alter table public.stock_movements
      add constraint stock_movements_reversed_movement_fk
      foreign key (reversed_movement_id) references public.stock_movements(id) not valid;
  end if;
end;
$$;

create or replace function private.inventory_operator_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(session.operator_name), ''), 'Staff')
  from private.inventory_staff_sessions session
  where session.token_hash = pg_catalog.encode(
    extensions.digest(coalesce(private.inventory_session_token(), ''), 'sha256'),
    'hex'
  )
    and session.revoked_at is null
    and session.expires_at > now()
  limit 1;
$$;

create or replace function private.touch_inventory_part()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.version := coalesce(old.version, 0) + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_inventory_part on public."Parts";
create trigger touch_inventory_part
before update on public."Parts"
for each row execute function private.touch_inventory_part();

create or replace view public.parts_public
with (security_invoker = true)
as
select
  id,
  "Part Name" as part_name,
  "Supplier Name" as supplier_name,
  "Manufacturer Part Number" as manufacturer_part_number,
  "Part Type" as part_type,
  "Description" as description,
  "Rack" as rack,
  "Shelf" as shelf,
  "Drawer" as drawer,
  "Area" as area,
  "Quantity" as quantity,
  manually_low,
  reorder_quantity,
  supplier_url,
  datasheet_url,
  image_url,
  purchase_price,
  version,
  updated_at
from public."Parts";

grant select on public.parts_public to anon;
grant update (manually_low, reorder_quantity, supplier_url, datasheet_url, image_url, purchase_price)
  on public."Parts" to anon;

drop function if exists public.inventory_adjust_stock(bigint, bigint, text, text, text);
create function public.inventory_adjust_stock(
  p_part_id bigint,
  p_delta bigint,
  p_movement_type text,
  p_job_number text default '',
  p_notes text default ''
)
returns table (new_quantity bigint, new_version bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_part public."Parts"%rowtype;
  v_new_quantity bigint;
  v_new_version bigint;
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

  select * into v_part from public."Parts" where id = p_part_id for update;
  if not found then raise exception 'Part not found.' using errcode = 'P0002'; end if;

  v_new_quantity := coalesce(v_part."Quantity", 0) + p_delta;
  if v_new_quantity < 0 then raise exception 'Insufficient stock.' using errcode = '22023'; end if;

  update public."Parts"
  set "Quantity" = v_new_quantity
  where id = p_part_id
  returning "Quantity", version into v_new_quantity, v_new_version;

  insert into public.stock_movements (
    part_id, part_name, manufacturer_part_number, movement_type, quantity,
    job_number, notes, performed_by
  ) values (
    v_part.id, coalesce(v_part."Part Name", ''), coalesce(v_part."Manufacturer Part Number", ''),
    btrim(p_movement_type), abs(p_delta), btrim(coalesce(p_job_number, '')),
    btrim(coalesce(p_notes, '')), private.inventory_operator_name()
  );

  return query select v_new_quantity, v_new_version;
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
  if (select count(distinct (value->>'part_id')::bigint) from jsonb_array_elements(p_items) as items(value)) <> v_count then
    raise exception 'Each part may only appear once in a bulk issue.' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as items(value) order by (value->>'part_id')::bigint loop
    begin
      v_part_id := (v_item->>'part_id')::bigint;
      v_quantity := (v_item->>'quantity')::bigint;
    exception when others then
      raise exception 'Every bulk item requires a valid part ID and quantity.' using errcode = '22023';
    end;
    if v_part_id is null or v_quantity is null or v_quantity < 1 then
      raise exception 'Bulk quantities must be greater than zero.' using errcode = '22023';
    end if;
    select * into v_part from public."Parts" where id = v_part_id for update;
    if not found then raise exception 'Part % was not found.', v_part_id using errcode = 'P0002'; end if;
    if coalesce(v_part."Quantity", 0) < v_quantity then
      raise exception 'Insufficient stock for %.', coalesce(v_part."Part Name", 'part') using errcode = '22023';
    end if;
    update public."Parts" set "Quantity" = coalesce(v_part."Quantity", 0) - v_quantity where id = v_part_id;
    insert into public.stock_movements (
      part_id, part_name, manufacturer_part_number, movement_type, quantity,
      job_number, notes, performed_by
    ) values (
      v_part.id, coalesce(v_part."Part Name", ''), coalesce(v_part."Manufacturer Part Number", ''),
      'JOB OUT', v_quantity, btrim(p_job_number), btrim(coalesce(p_notes, '')),
      private.inventory_operator_name()
    );
  end loop;
  return true;
end;
$$;

create or replace function public.inventory_reverse_movement(
  p_movement_id bigint,
  p_reason text
)
returns table (new_quantity bigint, new_version bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movement public.stock_movements%rowtype;
  v_part public."Parts"%rowtype;
  v_delta bigint;
begin
  if not private.has_valid_inventory_session() then
    raise exception 'A valid inventory session is required.' using errcode = '42501';
  end if;
  if p_movement_id is null or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception 'A correction reason is required.' using errcode = '22023';
  end if;
  select * into v_movement from public.stock_movements where id = p_movement_id for update;
  if not found then raise exception 'Movement not found.' using errcode = 'P0002'; end if;
  if v_movement.movement_type not in ('IN', 'OUT', 'MANUAL IN', 'MANUAL OUT', 'JOB OUT') then
    raise exception 'This movement cannot be reversed.' using errcode = '22023';
  end if;
  if exists (select 1 from public.stock_movements where reversed_movement_id = p_movement_id) then
    raise exception 'This movement has already been reversed.' using errcode = '22023';
  end if;
  select * into v_part from public."Parts" where id = v_movement.part_id for update;
  if not found then raise exception 'The original part no longer exists.' using errcode = 'P0002'; end if;
  v_delta := case when v_movement.movement_type in ('IN', 'MANUAL IN') then -v_movement.quantity else v_movement.quantity end;
  if coalesce(v_part."Quantity", 0) + v_delta < 0 then
    raise exception 'The correction would make stock negative.' using errcode = '22023';
  end if;
  update public."Parts" set "Quantity" = coalesce(v_part."Quantity", 0) + v_delta
  where id = v_part.id returning "Quantity", version into new_quantity, new_version;
  insert into public.stock_movements (
    part_id, part_name, manufacturer_part_number, movement_type, quantity, job_number,
    notes, performed_by, reversed_movement_id, reversal_reason
  ) values (
    v_part.id, coalesce(v_part."Part Name", ''), coalesce(v_part."Manufacturer Part Number", ''),
    'REVERSAL', v_movement.quantity, coalesce(v_movement.job_number, ''),
    'Reversal of movement #' || v_movement.id || ': ' || btrim(p_reason),
    private.inventory_operator_name(), v_movement.id, btrim(p_reason)
  );
  return next;
end;
$$;

create or replace function public.inventory_merge_parts(
  p_keep_id bigint,
  p_merge_ids bigint[]
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep public."Parts"%rowtype;
  v_source public."Parts"%rowtype;
  v_source_id bigint;
  v_total bigint;
begin
  if not private.has_valid_inventory_session() then
    raise exception 'A valid inventory session is required.' using errcode = '42501';
  end if;
  if p_keep_id is null or p_merge_ids is null or cardinality(p_merge_ids) not between 1 and 25
    or p_keep_id = any(p_merge_ids) then
    raise exception 'Choose one record to keep and one or more different records to merge.' using errcode = '22023';
  end if;
  if (select count(distinct item) from unnest(p_merge_ids) as item) <> cardinality(p_merge_ids) then
    raise exception 'A record was selected more than once.' using errcode = '22023';
  end if;
  select * into v_keep from public."Parts" where id = p_keep_id for update;
  if not found then raise exception 'The record to keep was not found.' using errcode = 'P0002'; end if;
  if char_length(btrim(coalesce(v_keep."Manufacturer Part Number", ''))) = 0 then
    raise exception 'Only records with a manufacturer part number can be merged.' using errcode = '22023';
  end if;
  v_total := coalesce(v_keep."Quantity", 0);
  foreach v_source_id in array p_merge_ids loop
    select * into v_source from public."Parts" where id = v_source_id for update;
    if not found then raise exception 'A record to merge was not found.' using errcode = 'P0002'; end if;
    if lower(btrim(coalesce(v_source."Manufacturer Part Number", ''))) <> lower(btrim(v_keep."Manufacturer Part Number")) then
      raise exception 'Only matching manufacturer part numbers may be merged.' using errcode = '22023';
    end if;
    v_total := v_total + coalesce(v_source."Quantity", 0);
    update public.stock_movements set part_id = v_keep.id where part_id = v_source.id;
    delete from public."Parts" where id = v_source.id;
  end loop;
  update public."Parts" set "Quantity" = v_total where id = v_keep.id;
  return true;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to anon;
grant execute on function private.has_valid_inventory_session() to anon;

revoke all on function public.inventory_adjust_stock(bigint, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.inventory_bulk_issue(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.inventory_reverse_movement(bigint, text) from public, anon, authenticated;
revoke all on function public.inventory_merge_parts(bigint, bigint[]) from public, anon, authenticated;
grant execute on function public.inventory_adjust_stock(bigint, bigint, text, text, text) to anon;
grant execute on function public.inventory_bulk_issue(text, text, jsonb) to anon;
grant execute on function public.inventory_reverse_movement(bigint, text) to anon;
grant execute on function public.inventory_merge_parts(bigint, bigint[]) to anon;

notify pgrst, 'reload schema';

commit;

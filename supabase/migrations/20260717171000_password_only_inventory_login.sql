begin;

-- This database belongs only to the Electrical Parts application. Remove the
-- unrelated cadet authentication RPC that was accidentally installed here.
drop function if exists public.authenticate_staff(text, text);

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

revoke all on function public.authenticate_inventory_staff(text) from public, anon, authenticated;
grant execute on function public.authenticate_inventory_staff(text) to anon;

notify pgrst, 'reload schema';

commit;

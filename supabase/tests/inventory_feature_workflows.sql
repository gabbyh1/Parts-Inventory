-- Run only after both migrations. This test rolls back every change it makes.
begin;

do $$
declare
  v_token text;
  v_first_id bigint;
  v_second_id bigint;
  v_movement_id bigint;
  v_quantity bigint;
begin
  perform public.set_inventory_staff_password('test-password-123');
  select session_token into v_token
  from public.authenticate_inventory_staff('test-password-123', 'Database test');

  perform set_config(
    'request.headers',
    jsonb_build_object('x-inventory-session', v_token)::text,
    true
  );

  insert into public."Parts" ("Part Name", "Manufacturer Part Number", "Quantity")
  values ('Database test part A', 'TEST-MPN-A', 3)
  returning id into v_first_id;

  insert into public."Parts" ("Part Name", "Manufacturer Part Number", "Quantity")
  values ('Database test part B', 'TEST-MPN-B', 1)
  returning id into v_second_id;

  select new_quantity into v_quantity
  from public.inventory_adjust_stock(v_first_id, 2, 'IN', 'TEST', 'Increase stock');
  if v_quantity <> 5 then
    raise exception 'Expected adjusted quantity 5, got %', v_quantity;
  end if;

  begin
    perform public.inventory_bulk_issue(
      'TEST-ATOMIC',
      'One row intentionally exceeds stock',
      jsonb_build_array(
        jsonb_build_object('part_id', v_first_id, 'quantity', 1),
        jsonb_build_object('part_id', v_second_id, 'quantity', 2)
      )
    );
    raise exception 'Expected bulk issue to reject insufficient stock.';
  exception when sqlstate = '22023' then
    null;
  end;

  select "Quantity" into v_quantity from public."Parts" where id = v_first_id;
  if v_quantity <> 5 then
    raise exception 'Bulk issue was not atomic; first quantity became %', v_quantity;
  end if;

  select id into v_movement_id
  from public.stock_movements
  where part_id = v_first_id and movement_type = 'IN'
  order by id desc
  limit 1;

  select new_quantity into v_quantity
  from public.inventory_reverse_movement(v_movement_id, 'Database test correction');
  if v_quantity <> 3 then
    raise exception 'Expected corrected quantity 3, got %', v_quantity;
  end if;

  update public."Parts" set manually_low = true where id = v_first_id;
  if not (select manually_low from public."Parts" where id = v_first_id) then
    raise exception 'Manual low-stock marker was not saved.';
  end if;

  insert into public."Parts" ("Part Name", "Manufacturer Part Number", "Quantity")
  values ('Database test duplicate', 'TEST-MPN-A', 2);
  perform public.inventory_merge_parts(
    v_first_id,
    array[(select id from public."Parts" where "Part Name" = 'Database test duplicate')]
  );
  select "Quantity" into v_quantity from public."Parts" where id = v_first_id;
  if v_quantity <> 5 then
    raise exception 'Expected merged quantity 5, got %', v_quantity;
  end if;
end;
$$;

rollback;

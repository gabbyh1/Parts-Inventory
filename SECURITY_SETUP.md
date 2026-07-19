# Parts Inventory security setup

The frontend requires the secure inventory migration. Apply these steps to the Supabase project before deploying the updated HTML, CSS, and JavaScript.

## 1. Back up the existing data

Export the following objects from Supabase before changing policies:

- `public."Parts"`
- `public.stock_movements`
- `public.stock_warning_rules`
- the definition of `public.parts_public`

## 2. Check existing data

The migration adds constraints for non-negative quantities and required part names. Find legacy rows that need correction:

```sql
select id, "Part Name", "Quantity"
from public."Parts"
where btrim(coalesce("Part Name", '')) = ''
   or "Quantity" is null
   or "Quantity" < 0
   or "Shelf" < 0
   or char_length(coalesce("Supplier Name", '')) > 200
   or char_length(coalesce("Manufacturer Part Number", '')) > 200
   or char_length(coalesce("Part Type", '')) > 100
   or char_length(coalesce("Description", '')) > 2000
   or char_length(coalesce("Rack", '')) > 100
   or char_length(coalesce("Drawer", '')) > 100
   or char_length(coalesce("Area", '')) > 500;

select id, part_type, warning_level
from public.stock_warning_rules
where btrim(coalesce(part_type, '')) = ''
   or warning_level is null
   or warning_level < 0;

select id, quantity
from public.stock_movements
where quantity is null
   or quantity <= 0;
```

Correct any returned rows before validating the new constraints.

## 3. Apply the migration

Run both migration files through the Supabase CLI or SQL editor, in this order:

1. `supabase/migrations/20260717_secure_inventory_workflows.sql`
2. `supabase/migrations/20260717_inventory_feature_extensions.sql`
3. `supabase/migrations/20260717171000_password_only_inventory_login.sql`

Use a new SQL Editor query for each file and select **No limit** before running it. Run them in the order shown.

The migration:

- stores only a bcrypt password hash;
- issues eight-hour, tab-scoped staff sessions;
- rate-limits failed login attempts;
- enables RLS on inventory tables;
- prevents anonymous inventory access without a valid session header;
- prevents direct updates to the quantity column;
- applies stock changes and movement history in one transaction;
- makes bulk job issues all-or-nothing.

The feature-extension migration adds manual low-stock selection, reorder quantities, supplier/datasheet/image references, version checks during edits, movement history, movement reversal, and safe duplicate-part merging.

## 4. Set the shared inventory password

In the Supabase SQL editor, choose a unique password of at least 6 characters and run:

```sql
select public.set_inventory_staff_password('replace-with-a-long-unique-password');
```

Never add the real password to this repository. Setting a new password revokes every existing inventory session.

## 5. Validate the constraints

After correcting legacy rows, run:

```sql
alter table public."Parts" validate constraint parts_quantity_nonnegative;
alter table public."Parts" validate constraint parts_name_required;
alter table public."Parts" validate constraint parts_text_lengths;
alter table public."Parts" validate constraint parts_shelf_nonnegative;
alter table public.stock_warning_rules validate constraint warning_level_nonnegative;
alter table public.stock_warning_rules validate constraint warning_part_type_required;
alter table public.stock_movements validate constraint movement_quantity_positive;
alter table public."Parts" validate constraint parts_reorder_quantity_nonnegative;
alter table public."Parts" validate constraint parts_purchase_price_nonnegative;
```

## 6. Deploy and test

Deploy `index.html`, `style.css`, and `script.js` together. Then verify:

1. The shared password works without a username, and an incorrect password is rejected.
2. Ten failed attempts trigger the temporary lockout.
3. Reloading the same tab restores a valid session.
4. Logging out invalidates the server session.
5. Stock cannot be issued below zero.
6. A bulk job with one invalid row saves no rows.
7. Every successful stock change creates one matching history row.
8. Requests made without `x-inventory-session` receive no inventory data.
9. A manually marked low-stock part appears in Stock Warnings and the Reorder List.
10. A CSV import shows a preview and does not import duplicate part numbers without review.
11. Reversing a movement creates one correction row and does not permit a negative quantity.

The Supabase publishable key remains in `script.js` by design. Security depends on the migration's RLS policies and server-side functions, not on hiding that public key.

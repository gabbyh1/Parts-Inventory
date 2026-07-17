# Database workflow test

Run `inventory_feature_workflows.sql` in the Supabase SQL Editor only after both migrations have completed. It exercises authenticated stock adjustment, atomic bulk issues, correction/reversal, manual low-stock flags, and duplicate merging inside a transaction that is rolled back at the end.

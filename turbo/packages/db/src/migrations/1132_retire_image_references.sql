-- Reference images are abandoned; #33203 is reverted in full. The switch was
-- never enabled for any organization, so no row was ever written and no
-- draining API version can reach this table.
-- RESTRICT instead of the generated CASCADE: nothing may depend on this table,
-- and an unexpected dependency must fail the migration, not be dropped with it.
DROP TABLE "image_references" RESTRICT;

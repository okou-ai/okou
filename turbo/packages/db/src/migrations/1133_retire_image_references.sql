-- Reference images are abandoned; the #33203 backend slice is removed. The
-- switch was never enabled for any organization, so no row was ever written
-- and no draining API version can reach this table.
-- RESTRICT instead of the generated CASCADE: nothing may depend on this table,
-- and an unexpected dependency must fail the migration, not be dropped with it.
DROP TABLE "image_references" RESTRICT;

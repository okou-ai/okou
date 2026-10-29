-- #34149 retired renewal and its refresh_after readers. Outgoing API writers
-- still supply the column, so keep it until a later rollback-floored drop.
ALTER TABLE "system_storage_presigned_url_cache" ALTER COLUMN "refresh_after" DROP NOT NULL;

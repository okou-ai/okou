-- Backfill existing rows. Replay after old API writers drain to cover rows
-- they wrote without an association. Preserve all existing device links.
WITH assigned AS (
  UPDATE "computer_use_hosts"
  SET "remote_device_id" = gen_random_uuid()
  WHERE "remote_device_id" IS NULL
  RETURNING "remote_device_id", "org_id", "user_id", "display_name"
)
INSERT INTO "remote_devices" ("id", "org_id", "user_id", "display_name")
SELECT "remote_device_id", "org_id", "user_id", "display_name" FROM assigned;
--> statement-breakpoint
WITH assigned AS (
  UPDATE "phone_use_devices"
  SET "remote_device_id" = gen_random_uuid()
  WHERE "remote_device_id" IS NULL
  RETURNING "remote_device_id", "org_id", "user_id", "display_name"
)
INSERT INTO "remote_devices" ("id", "org_id", "user_id", "display_name")
SELECT "remote_device_id", "org_id", "user_id", "display_name" FROM assigned;
--> statement-breakpoint
WITH assigned AS (
  UPDATE "ssh_connections"
  SET "remote_device_id" = gen_random_uuid()
  WHERE "remote_device_id" IS NULL
  RETURNING "remote_device_id", "org_id", "user_id", "display_name"
)
INSERT INTO "remote_devices" ("id", "org_id", "user_id", "display_name")
SELECT "remote_device_id", "org_id", "user_id", "display_name" FROM assigned;
--> statement-breakpoint
WITH assigned AS (
  UPDATE "vnc_connections"
  SET "remote_device_id" = gen_random_uuid()
  WHERE "remote_device_id" IS NULL
  RETURNING "remote_device_id", "org_id", "user_id", "display_name"
)
INSERT INTO "remote_devices" ("id", "org_id", "user_id", "display_name")
SELECT "remote_device_id", "org_id", "user_id", "display_name" FROM assigned;

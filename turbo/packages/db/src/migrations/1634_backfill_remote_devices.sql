-- The compatibility hooks already cover new inserts. Updating only rows with
-- no association makes reruns safe and preserves explicit moves.
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

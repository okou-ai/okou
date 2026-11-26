-- Assign each legacy channel its own device. Existing policies and links are untouched.
WITH desktop AS (
  UPDATE computer_use_hosts
  SET remote_device_id = gen_random_uuid()
  WHERE remote_device_id IS NULL
  RETURNING remote_device_id, org_id, user_id, display_name
),
phone AS (
  UPDATE phone_use_devices
  SET remote_device_id = gen_random_uuid()
  WHERE remote_device_id IS NULL
  RETURNING remote_device_id, org_id, user_id, display_name
),
ssh AS (
  UPDATE ssh_connections
  SET remote_device_id = gen_random_uuid()
  WHERE remote_device_id IS NULL
  RETURNING remote_device_id, org_id, user_id, display_name
),
vnc AS (
  UPDATE vnc_connections
  SET remote_device_id = gen_random_uuid()
  WHERE remote_device_id IS NULL
  RETURNING remote_device_id, org_id, user_id, display_name
), linked AS (
  SELECT * FROM desktop
  UNION ALL
  SELECT * FROM phone
  UNION ALL
  SELECT * FROM ssh
  UNION ALL
  SELECT * FROM vnc
)
INSERT INTO remote_devices (id, org_id, user_id, display_name)
SELECT
  remote_device_id,
  org_id,
  user_id,
  -- The ECMAScript trim set, including BOM and excluding U+0085 and U+180E.
  COALESCE(NULLIF(btrim(display_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), ''), 'Unnamed device')
FROM linked;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM computer_use_hosts WHERE remote_device_id IS NULL)
    OR EXISTS (SELECT 1 FROM phone_use_devices WHERE remote_device_id IS NULL)
    OR EXISTS (SELECT 1 FROM ssh_connections WHERE remote_device_id IS NULL)
    OR EXISTS (SELECT 1 FROM vnc_connections WHERE remote_device_id IS NULL)
  THEN
    RAISE EXCEPTION 'Remote device backfill left unassociated channels';
  END IF;
END $$;

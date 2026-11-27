ALTER TABLE "remote_devices" ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
CREATE FUNCTION "require_active_remote_device"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_deleted_at timestamp;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.remote_device_id = NEW.remote_device_id THEN
    RETURN NEW;
  END IF;

  SELECT deleted_at INTO target_deleted_at
  FROM remote_devices
  WHERE id = NEW.remote_device_id AND org_id = NEW.org_id AND user_id = NEW.user_id
  FOR SHARE;

  IF target_deleted_at IS NOT NULL THEN
    RAISE foreign_key_violation USING
      MESSAGE = 'Remote device is no longer available',
      CONSTRAINT = TG_TABLE_NAME || '_remote_device_owner_fk';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "computer_use_host_active_remote_device"
AFTER INSERT OR UPDATE OF remote_device_id ON "computer_use_hosts"
FOR EACH ROW EXECUTE FUNCTION "require_active_remote_device"();
--> statement-breakpoint
CREATE TRIGGER "phone_use_device_active_remote_device"
AFTER INSERT OR UPDATE OF remote_device_id ON "phone_use_devices"
FOR EACH ROW EXECUTE FUNCTION "require_active_remote_device"();
--> statement-breakpoint
CREATE TRIGGER "ssh_connection_active_remote_device"
AFTER INSERT OR UPDATE OF remote_device_id ON "ssh_connections"
FOR EACH ROW EXECUTE FUNCTION "require_active_remote_device"();
--> statement-breakpoint
CREATE TRIGGER "vnc_connection_active_remote_device"
AFTER INSERT OR UPDATE OF remote_device_id ON "vnc_connections"
FOR EACH ROW EXECUTE FUNCTION "require_active_remote_device"();
--> statement-breakpoint
CREATE FUNCTION "require_deleted_remote_device_to_be_empty"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT FROM computer_use_hosts WHERE remote_device_id = NEW.id AND revoked_at IS NULL)
     OR EXISTS (SELECT FROM phone_use_devices WHERE remote_device_id = NEW.id)
     OR EXISTS (SELECT FROM ssh_connections WHERE remote_device_id = NEW.id)
     OR EXISTS (SELECT FROM vnc_connections WHERE remote_device_id = NEW.id) THEN
    RAISE foreign_key_violation USING
      MESSAGE = 'A channel was attached while the remote device was being deleted',
      CONSTRAINT = 'remote_device_deleted_empty';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "deleted_remote_device_is_empty"
AFTER UPDATE OF deleted_at ON "remote_devices"
FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION "require_deleted_remote_device_to_be_empty"();

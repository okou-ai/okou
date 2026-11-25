CREATE TABLE "remote_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"access_allowed" boolean DEFAULT false NOT NULL,
	"access_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_remote_devices_id_owner" UNIQUE("id","org_id","user_id"),
	CONSTRAINT "chk_remote_devices_access_expiry" CHECK ("remote_devices"."access_allowed" OR "remote_devices"."access_expires_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "remote_device_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_use_devices" ADD COLUMN "remote_device_id" uuid;--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD COLUMN "remote_device_id" uuid;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "remote_device_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_remote_devices_owner" ON "remote_devices" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD CONSTRAINT "computer_use_hosts_remote_device_owner_fk" FOREIGN KEY ("remote_device_id","org_id","user_id") REFERENCES "public"."remote_devices"("id","org_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_use_devices" ADD CONSTRAINT "phone_use_devices_remote_device_owner_fk" FOREIGN KEY ("remote_device_id","org_id","user_id") REFERENCES "public"."remote_devices"("id","org_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "ssh_connections_remote_device_owner_fk" FOREIGN KEY ("remote_device_id","org_id","user_id") REFERENCES "public"."remote_devices"("id","org_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "vnc_connections_remote_device_owner_fk" FOREIGN KEY ("remote_device_id","org_id","user_id") REFERENCES "public"."remote_devices"("id","org_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_computer_use_hosts_remote_device" ON "computer_use_hosts" USING btree ("remote_device_id");--> statement-breakpoint
CREATE INDEX "idx_phone_use_devices_remote_device" ON "phone_use_devices" USING btree ("remote_device_id");--> statement-breakpoint
CREATE INDEX "idx_ssh_connections_remote_device" ON "ssh_connections" USING btree ("remote_device_id");--> statement-breakpoint
CREATE INDEX "idx_vnc_connections_remote_device" ON "vnc_connections" USING btree ("remote_device_id");
--> statement-breakpoint
-- Old writers can omit remote_device_id. Run only after a successful insert,
-- so an installation upsert never allocates a device for its losing row.
CREATE FUNCTION public.attach_new_remote_channel() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  device_id uuid;
BEGIN
  INSERT INTO public.remote_devices (org_id, user_id, display_name)
  VALUES (NEW.org_id, NEW.user_id, NEW.display_name)
  RETURNING id INTO device_id;

  EXECUTE format(
    'UPDATE %I.%I SET remote_device_id = $1 WHERE id = $2',
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME
  ) USING device_id, NEW.id;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attach_new_remote_channel
AFTER INSERT ON public.computer_use_hosts
FOR EACH ROW WHEN (NEW.remote_device_id IS NULL)
EXECUTE FUNCTION public.attach_new_remote_channel();
--> statement-breakpoint
CREATE TRIGGER attach_new_remote_channel
AFTER INSERT ON public.phone_use_devices
FOR EACH ROW WHEN (NEW.remote_device_id IS NULL)
EXECUTE FUNCTION public.attach_new_remote_channel();
--> statement-breakpoint
CREATE TRIGGER attach_new_remote_channel
AFTER INSERT ON public.ssh_connections
FOR EACH ROW WHEN (NEW.remote_device_id IS NULL)
EXECUTE FUNCTION public.attach_new_remote_channel();
--> statement-breakpoint
CREATE TRIGGER attach_new_remote_channel
AFTER INSERT ON public.vnc_connections
FOR EACH ROW WHEN (NEW.remote_device_id IS NULL)
EXECUTE FUNCTION public.attach_new_remote_channel();

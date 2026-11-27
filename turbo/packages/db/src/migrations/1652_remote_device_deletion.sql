ALTER TABLE "computer_use_hosts" ADD COLUMN "active_remote_device_id" uuid GENERATED ALWAYS AS (CASE WHEN revoked_at IS NULL THEN remote_device_id END) STORED;--> statement-breakpoint
ALTER TABLE "remote_devices" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "remote_devices" ADD COLUMN "active_id" uuid GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN id END) STORED;--> statement-breakpoint
ALTER TABLE "remote_devices" ADD CONSTRAINT "remote_devices_active_id_unique" UNIQUE("active_id");--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD CONSTRAINT "computer_use_hosts_remote_device_active_fk" FOREIGN KEY ("active_remote_device_id") REFERENCES "public"."remote_devices"("active_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_use_devices" ADD CONSTRAINT "phone_use_devices_remote_device_active_fk" FOREIGN KEY ("remote_device_id") REFERENCES "public"."remote_devices"("active_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "ssh_connections_remote_device_active_fk" FOREIGN KEY ("remote_device_id") REFERENCES "public"."remote_devices"("active_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "vnc_connections_remote_device_active_fk" FOREIGN KEY ("remote_device_id") REFERENCES "public"."remote_devices"("active_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_computer_use_hosts_active_remote_device" ON "computer_use_hosts" USING btree ("active_remote_device_id");

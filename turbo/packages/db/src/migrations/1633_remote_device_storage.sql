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

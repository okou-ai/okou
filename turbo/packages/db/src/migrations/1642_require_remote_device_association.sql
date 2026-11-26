ALTER TABLE "computer_use_hosts" ALTER COLUMN "remote_device_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_use_devices" ALTER COLUMN "remote_device_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ssh_connections" ALTER COLUMN "remote_device_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vnc_connections" ALTER COLUMN "remote_device_id" SET NOT NULL;
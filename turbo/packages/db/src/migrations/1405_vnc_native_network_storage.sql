ALTER TABLE "vnc_connection_observations" DROP CONSTRAINT "chk_vnc_connection_observation_failure";--> statement-breakpoint
ALTER TABLE "vnc_connections" DROP CONSTRAINT "chk_vnc_connections_transport";--> statement-breakpoint
ALTER TABLE "vnc_connections" DROP CONSTRAINT "chk_vnc_connections_profile";--> statement-breakpoint
ALTER TABLE "vnc_connections" DROP CONSTRAINT "chk_vnc_connections_kdc";--> statement-breakpoint
ALTER TABLE "vnc_connections" ALTER COLUMN "transport_type" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "vnc_connections" ALTER COLUMN "transport_type" SET DEFAULT 'direct';--> statement-breakpoint
ALTER TABLE "vnc_connections" ALTER COLUMN "kdc_transport_type" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "cloudflare_access_id" uuid;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "tailscale_id" uuid;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "origin_tls_server_name" varchar(253);--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "origin_tls_trust_mode" varchar(16);--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "origin_tls_ca_bundle" text;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "kdc_cloudflare_access_id" uuid;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "kdc_tailscale_id" uuid;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "vnc_connections_cloudflare_org_fk" FOREIGN KEY ("cloudflare_access_id","org_id") REFERENCES "public"."cloudflare_access_configs"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "vnc_connections_tailscale_org_fk" FOREIGN KEY ("tailscale_id","org_id") REFERENCES "public"."tailscale_configs"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "vnc_connections_kdc_cloudflare_org_fk" FOREIGN KEY ("kdc_cloudflare_access_id","org_id") REFERENCES "public"."cloudflare_access_configs"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "vnc_connections_kdc_tailscale_org_fk" FOREIGN KEY ("kdc_tailscale_id","org_id") REFERENCES "public"."tailscale_configs"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vnc_connections_cloudflare" ON "vnc_connections" USING btree ("cloudflare_access_id","id");--> statement-breakpoint
CREATE INDEX "idx_vnc_connections_tailscale" ON "vnc_connections" USING btree ("tailscale_id","id");--> statement-breakpoint
CREATE INDEX "idx_vnc_connections_kdc_cloudflare" ON "vnc_connections" USING btree ("kdc_cloudflare_access_id","id");--> statement-breakpoint
CREATE INDEX "idx_vnc_connections_kdc_tailscale" ON "vnc_connections" USING btree ("kdc_tailscale_id","id");--> statement-breakpoint
ALTER TABLE "vnc_connection_observations" ADD CONSTRAINT "chk_vnc_connection_observation_failure" CHECK ("vnc_connection_observations"."failure_reason" IS NULL OR "vnc_connection_observations"."failure_reason" IN ('invalid_credential', 'unsafe_destination', 'network_failure', 'protocol', 'timed_out', 'disconnected', 'authentication_failed', 'unsupported_profile', 'kerberos_expired', 'kerberos_non_renewable', 'kerberos_renewal_exhausted', 'access_rejected', 'access_tls_failure', 'access_protocol_failure', 'origin_tls_failure', 'tailscale_unavailable'));--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "chk_vnc_connections_origin_tls" CHECK (("vnc_connections"."origin_tls_server_name" IS NULL AND "vnc_connections"."origin_tls_trust_mode" IS NULL AND "vnc_connections"."origin_tls_ca_bundle" IS NULL)
          OR ("vnc_connections"."transport_type" = 'cloudflare_access'
            AND "vnc_connections"."origin_tls_server_name" IS NOT NULL AND char_length("vnc_connections"."origin_tls_server_name") BETWEEN 1 AND 253
            AND "vnc_connections"."origin_tls_server_name" = lower("vnc_connections"."origin_tls_server_name")
            AND "vnc_connections"."origin_tls_server_name" !~ '[[:space:][:cntrl:]/@?#%\[\]\\]'
            AND "vnc_connections"."origin_tls_trust_mode" IS NOT NULL
            AND (("vnc_connections"."origin_tls_trust_mode" = 'system' AND "vnc_connections"."origin_tls_ca_bundle" IS NULL)
              OR ("vnc_connections"."origin_tls_trust_mode" = 'custom_ca' AND "vnc_connections"."origin_tls_ca_bundle" IS NOT NULL AND octet_length("vnc_connections"."origin_tls_ca_bundle") BETWEEN 1 AND 65536))));--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "chk_vnc_connections_transport" CHECK (("vnc_connections"."transport_type" = 'direct' AND "vnc_connections"."ssh_connection_id" IS NULL AND "vnc_connections"."cloudflare_access_id" IS NULL AND "vnc_connections"."tailscale_id" IS NULL)
          OR ("vnc_connections"."transport_type" = 'ssh' AND "vnc_connections"."ssh_connection_id" IS NOT NULL AND "vnc_connections"."cloudflare_access_id" IS NULL AND "vnc_connections"."tailscale_id" IS NULL)
          OR ("vnc_connections"."transport_type" = 'cloudflare_access' AND "vnc_connections"."ssh_connection_id" IS NULL AND "vnc_connections"."tailscale_id" IS NULL AND "vnc_connections"."port" = 443)
          OR ("vnc_connections"."transport_type" = 'tailscale' AND "vnc_connections"."ssh_connection_id" IS NULL AND "vnc_connections"."cloudflare_access_id" IS NULL));--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "chk_vnc_connections_profile" CHECK (("vnc_connections"."credential_id" IS NOT NULL AND "vnc_connections"."auth_method" IN ('rsa_aes_password', 'rsa_aes_username_password') AND (("vnc_connections"."security_type" IN ('rsa_aes_ra2', 'rsa_aes_ra2_256')) OR ("vnc_connections"."security_type" IN ('rsa_aes_ra2ne', 'rsa_aes_ra2ne_256') AND (("vnc_connections"."transport_type" = 'ssh' AND "vnc_connections"."host" IN ('127.0.0.1', '::1'))
      OR "vnc_connections"."transport_type" = 'tailscale'
      OR ("vnc_connections"."transport_type" = 'cloudflare_access' AND "vnc_connections"."origin_tls_server_name" IS NOT NULL))))) OR ("vnc_connections"."auth_method" = 'none' AND "vnc_connections"."security_type" = 'x509_none' AND "vnc_connections"."credential_id" IS NULL) OR ("vnc_connections"."credential_id" IS NOT NULL AND (("vnc_connections"."auth_method" = 'client_certificate' AND "vnc_connections"."security_type" = 'x509_none') OR ("vnc_connections"."auth_method" = 'client_certificate_vnc_password' AND "vnc_connections"."security_type" = 'x509_vnc') OR ("vnc_connections"."auth_method" = 'vnc_password' AND "vnc_connections"."security_type" = 'x509_vnc') OR ("vnc_connections"."auth_method" = 'vnc_password' AND "vnc_connections"."security_type" = 'apple_vnc_password' AND (("vnc_connections"."transport_type" = 'ssh' AND "vnc_connections"."host" IN ('127.0.0.1', '::1'))
      OR "vnc_connections"."transport_type" = 'tailscale'
      OR ("vnc_connections"."transport_type" = 'cloudflare_access' AND "vnc_connections"."origin_tls_server_name" IS NOT NULL)) AND "vnc_connections"."x509_server_name" IS NULL) OR ("vnc_connections"."auth_method" = 'username_password' AND "vnc_connections"."security_type" = 'x509_plain') OR ("vnc_connections"."auth_method" = 'qemu_scram_sha256' AND "vnc_connections"."security_type" = 'qemu_x509_sasl') OR ("vnc_connections"."auth_method" = 'apple_dh_username_password' AND "vnc_connections"."security_type" = 'apple_dh' AND (("vnc_connections"."transport_type" = 'ssh' AND "vnc_connections"."host" IN ('127.0.0.1', '::1'))
      OR "vnc_connections"."transport_type" = 'tailscale'
      OR ("vnc_connections"."transport_type" = 'cloudflare_access' AND "vnc_connections"."origin_tls_server_name" IS NOT NULL)) AND "vnc_connections"."x509_server_name" IS NULL) OR ("vnc_connections"."auth_method" = 'apple_srp_username_password' AND "vnc_connections"."security_type" = 'apple_srp' AND (("vnc_connections"."transport_type" = 'ssh' AND "vnc_connections"."host" IN ('127.0.0.1', '::1'))
      OR "vnc_connections"."transport_type" = 'tailscale'
      OR ("vnc_connections"."transport_type" = 'cloudflare_access' AND "vnc_connections"."origin_tls_server_name" IS NOT NULL)) AND "vnc_connections"."x509_server_name" IS NULL) OR ("vnc_connections"."auth_method" = 'apple_rsa_srp_username_password' AND "vnc_connections"."security_type" = 'apple_rsa_srp' AND (("vnc_connections"."transport_type" = 'ssh' AND "vnc_connections"."host" IN ('127.0.0.1', '::1'))
      OR "vnc_connections"."transport_type" = 'tailscale'
      OR ("vnc_connections"."transport_type" = 'cloudflare_access' AND "vnc_connections"."origin_tls_server_name" IS NOT NULL)) AND "vnc_connections"."x509_server_name" IS NULL))) OR ("vnc_connections"."auth_method" IN ('qemu_kerberos_ticket', 'qemu_kerberos_keytab', 'qemu_kerberos_password') AND "vnc_connections"."security_type" = 'qemu_x509_gssapi' AND "vnc_connections"."credential_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "chk_vnc_connections_kdc" CHECK (CASE
        WHEN "vnc_connections"."auth_method" IN ('qemu_kerberos_keytab', 'qemu_kerberos_password') THEN
          "vnc_connections"."kdc_transport_type" IS NOT NULL AND "vnc_connections"."kdc_host" IS NOT NULL
          AND octet_length("vnc_connections"."kdc_host") BETWEEN 1 AND 253
          AND "vnc_connections"."kdc_port" IS NOT NULL AND "vnc_connections"."kdc_port" BETWEEN 1 AND 65535
          AND "vnc_connections"."kerberos_ticket_lifetime_seconds" IS NOT NULL AND "vnc_connections"."kerberos_ticket_lifetime_seconds" BETWEEN 1 AND 7200
          AND "vnc_connections"."kerberos_renewable_lifetime_seconds" IS NOT NULL AND "vnc_connections"."kerberos_renewable_lifetime_seconds" BETWEEN 0 AND 7200
          AND (("vnc_connections"."kdc_transport_type" = 'direct' AND "vnc_connections"."kdc_ssh_connection_id" IS NULL AND "vnc_connections"."kdc_cloudflare_access_id" IS NULL AND "vnc_connections"."kdc_tailscale_id" IS NULL)
            OR ("vnc_connections"."kdc_transport_type" = 'ssh' AND "vnc_connections"."kdc_ssh_connection_id" IS NOT NULL AND "vnc_connections"."kdc_cloudflare_access_id" IS NULL AND "vnc_connections"."kdc_tailscale_id" IS NULL AND "vnc_connections"."kdc_host" IN ('127.0.0.1', '::1'))
            OR ("vnc_connections"."kdc_transport_type" = 'cloudflare_access' AND "vnc_connections"."kdc_ssh_connection_id" IS NULL AND "vnc_connections"."kdc_tailscale_id" IS NULL AND "vnc_connections"."kdc_port" = 443)
            OR ("vnc_connections"."kdc_transport_type" = 'tailscale' AND "vnc_connections"."kdc_ssh_connection_id" IS NULL AND "vnc_connections"."kdc_cloudflare_access_id" IS NULL))
        ELSE "vnc_connections"."kdc_transport_type" IS NULL AND "vnc_connections"."kdc_host" IS NULL AND "vnc_connections"."kdc_port" IS NULL
          AND "vnc_connections"."kdc_ssh_connection_id" IS NULL AND "vnc_connections"."kdc_cloudflare_access_id" IS NULL AND "vnc_connections"."kdc_tailscale_id" IS NULL AND "vnc_connections"."kerberos_ticket_lifetime_seconds" IS NULL
          AND "vnc_connections"."kerberos_renewable_lifetime_seconds" IS NULL END);
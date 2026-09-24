ALTER TABLE "ssh_connections" DROP CONSTRAINT "chk_ssh_connections_cloudflare_access_destination";--> statement-breakpoint
ALTER TABLE "ssh_connections" DROP CONSTRAINT "ssh_connections_cloudflare_access_owner_fk";
--> statement-breakpoint
ALTER TABLE "cloudflare_access_configs" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloudflare_access_configs" ADD COLUMN "scope" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD COLUMN "needs_rebind" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cloudflare_access_configs" ADD CONSTRAINT "uq_cloudflare_access_configs_org_id" UNIQUE("id","org_id");--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "ssh_connections_cloudflare_access_org_fk" FOREIGN KEY ("cloudflare_access_id","org_id") REFERENCES "public"."cloudflare_access_configs"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_access_configs" ADD CONSTRAINT "chk_cloudflare_access_configs_scope_owner" CHECK (("cloudflare_access_configs"."scope" = 'personal' AND "cloudflare_access_configs"."user_id" IS NOT NULL) OR ("cloudflare_access_configs"."scope" = 'organization' AND "cloudflare_access_configs"."user_id" IS NULL));--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "chk_ssh_connections_needs_rebind_unbound" CHECK (NOT "ssh_connections"."needs_rebind" OR "ssh_connections"."cloudflare_access_id" IS NULL);--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "chk_ssh_connections_cloudflare_access_destination" CHECK (("ssh_connections"."cloudflare_access_id" IS NULL AND NOT "ssh_connections"."needs_rebind") OR ("ssh_connections"."port" = 443 AND "ssh_connections"."host" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND "ssh_connections"."host" !~ '^[0-9.]+$'));
--> statement-breakpoint
CREATE FUNCTION validate_ssh_cloudflare_access_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected_scope text;
  selected_user_id text;
BEGIN
  IF NEW.cloudflare_access_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT scope, user_id INTO selected_scope, selected_user_id
    FROM cloudflare_access_configs
    WHERE id = NEW.cloudflare_access_id AND org_id = NEW.org_id
    FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- The same-organization FK reports the missing row.
  END IF;
  IF selected_scope = 'personal' AND selected_user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'SSH Cloudflare Access personal owner mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'ssh_connections_cloudflare_access_personal_owner_guard';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ssh_cloudflare_access_binding_guard
BEFORE INSERT OR UPDATE OF cloudflare_access_id, org_id, user_id ON ssh_connections
FOR EACH ROW EXECUTE FUNCTION validate_ssh_cloudflare_access_binding();
--> statement-breakpoint
CREATE FUNCTION reject_cloudflare_access_scope_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.scope IS DISTINCT FROM NEW.scope
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'Cloudflare Access scope and owner are immutable before conversion activation'
      USING ERRCODE = '23514', CONSTRAINT = 'cloudflare_access_scope_change_guard';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cloudflare_access_scope_change_guard
BEFORE UPDATE OF scope, user_id, org_id ON cloudflare_access_configs
FOR EACH ROW EXECUTE FUNCTION reject_cloudflare_access_scope_change();

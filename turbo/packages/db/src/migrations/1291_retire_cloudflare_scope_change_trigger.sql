-- Every scope-changing API writer locks the configuration and detaches
-- incompatible hosts before converting its owner. Keep the SSH binding guard:
-- it still validates late attachments from foundation-era API requests.
DROP TRIGGER cloudflare_access_scope_change_guard ON cloudflare_access_configs;
--> statement-breakpoint
DROP FUNCTION reject_cloudflare_access_scope_change();

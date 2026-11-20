DROP TABLE "user_custom_connectors";--> statement-breakpoint
DROP TABLE "user_permission_grants";--> statement-breakpoint
ALTER TABLE "connector_external_code_sessions" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "connector_external_code_sessions" DROP COLUMN "authorize_agent";--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" DROP COLUMN "authorize_agent";--> statement-breakpoint
ALTER TABLE "connector_oauth_states" DROP COLUMN "authorize_agent";

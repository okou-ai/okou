import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { sql } from "drizzle-orm";

/** Existing consent identity, supplied only by the device-auth command. */
export interface DeviceAuthSessionPublication {
  readonly id: string;
  readonly userId: string;
  readonly source: "claude-code-device-auth" | "codex-device-auth";
}

/** Pure SQL; the credential-owning command executes this before committing. */
export function deviceAuthSessionPublicationSql(args: {
  readonly orgId: string;
  readonly type: string;
  readonly authSession?: DeviceAuthSessionPublication;
}) {
  const session = args.authSession;
  return session === undefined
    ? undefined
    : sql`
    UPDATE ${modelProviderAuthSessions}
    SET status = 'imported', approval_url = NULL, verification_code = NULL,
        encrypted_provider_state = NULL, error_message = NULL,
        completed_at = clock_timestamp(), cancelled_at = NULL,
        updated_at = clock_timestamp()
    WHERE ${modelProviderAuthSessions.id} = ${session.id}
      AND ${modelProviderAuthSessions.orgId} = ${args.orgId}
      AND ${modelProviderAuthSessions.userId} = ${session.userId}
      AND ${modelProviderAuthSessions.connectorType} = ${args.type}
      AND ${modelProviderAuthSessions.source} = ${session.source}
      AND ${modelProviderAuthSessions.status} = 'completing'
      AND ${modelProviderAuthSessions.expiresAt} > clock_timestamp()
    RETURNING ${modelProviderAuthSessions.id}`;
}

import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { sql, type SQL } from "drizzle-orm";

/** Consent or grant identity supplied by its credential-owning command. */
export interface DeviceAuthSessionPublication {
  readonly id: string;
  readonly userId: string;
  readonly source:
    "claude-code-device-auth" | "codex-device-auth" | "atom-subscription-grant";
}

/** Pure SQL; the credential-owning command executes this before committing. */
export function deviceAuthSessionPublicationSql(args: {
  readonly orgId: string;
  readonly type: string;
  readonly modelProviderAccountId: string;
  readonly authSession?: DeviceAuthSessionPublication;
  readonly publicationReadyAt: SQL;
}) {
  const session = args.authSession;
  return session === undefined
    ? undefined
    : sql`
    UPDATE ${modelProviderAuthSessions}
    SET status = 'imported', approval_url = NULL, verification_code = NULL,
        encrypted_provider_state = NULL, error_message = NULL,
        completed_at = clock_timestamp(), cancelled_at = NULL,
        model_provider_account_id = ${args.modelProviderAccountId},
        updated_at = clock_timestamp()
    WHERE ${modelProviderAuthSessions.id} = ${session.id}
      AND ${modelProviderAuthSessions.orgId} = ${args.orgId}
      AND ${modelProviderAuthSessions.userId} = ${session.userId}
      AND ${modelProviderAuthSessions.connectorType} = ${args.type}
      AND ${modelProviderAuthSessions.source} = ${session.source}
      AND ${modelProviderAuthSessions.status} = 'completing'
      AND ${modelProviderAuthSessions.expiresAt} > ${args.publicationReadyAt}
    RETURNING ${modelProviderAuthSessions.id}`;
}

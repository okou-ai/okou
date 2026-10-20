import { and, eq, exists, gt, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { desktopShellAuthorizations } from "@okouai/db/schema/desktop-shell-authorization";
import { computerUseCommands } from "@okouai/db/schema/computer-use-host";

/** Only the exact grant captured at admission can authorize a queued command. */
export function computerUseCommandHasShellGrant(now: Date) {
  return exists(
    new QueryBuilder()
      .select({ id: desktopShellAuthorizations.id })
      .from(desktopShellAuthorizations)
      .where(
        and(
          eq(
            desktopShellAuthorizations.id,
            computerUseCommands.shellAuthorizationId,
          ),
          eq(desktopShellAuthorizations.orgId, computerUseCommands.orgId),
          eq(desktopShellAuthorizations.userId, computerUseCommands.userId),
          eq(
            desktopShellAuthorizations.computerUseHostId,
            computerUseCommands.hostId,
          ),
          eq(desktopShellAuthorizations.status, "approved"),
          gt(desktopShellAuthorizations.grantExpiresAt, now),
        ),
      ),
  );
}

const shellGrantDeniedResult = Object.freeze({
  error: Object.freeze({
    code: "permission_denied",
    message:
      "Shell authorization expired or was revoked. Request access again; do not replay input.",
  }),
});

export function queuedShellGrantDeniedValues(now: Date) {
  return {
    status: "failed",
    result: shellGrantDeniedResult,
    error: shellGrantDeniedResult.error.message,
    completedAt: now,
    updatedAt: now,
  };
}

export function queuedShellCommandCondition() {
  return and(
    eq(computerUseCommands.status, "queued"),
    sql`${computerUseCommands.kind} LIKE 'shell.%'`,
  );
}

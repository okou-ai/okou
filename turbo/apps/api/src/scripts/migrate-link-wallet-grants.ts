import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { linkWalletConnections } from "@okouai/db/schema/link-wallet";

import { closeDbPool, db } from "../lib/db";
import { now, nowDate } from "../lib/time";
import { settleIncludingAbort } from "../signals/utils";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "../signals/services/crypto.utils";
import {
  linkCredentialsSchema,
  linkTokenRequest,
  revokeLinkToken,
} from "../signals/services/link-wallet-provider.service";

// The only legacy shape accepted by this one-time operator came from the
// payment-only writer. Partial metadata is corruption, not evidence of consent.
const migrationCredentialsSchema = linkCredentialsSchema.partial({
  scope: true,
  readOnly: true,
});

async function* connections() {
  let cursor: string | undefined;
  for (;;) {
    const rows = await db()
      .select({
        id: linkWalletConnections.id,
        authorizationId: linkWalletConnections.authorizationId,
        encryptedCredentials: linkWalletConnections.encryptedCredentials,
        revokedAt: linkWalletConnections.revokedAt,
      })
      .from(linkWalletConnections)
      .where(
        and(
          isNotNull(linkWalletConnections.encryptedCredentials),
          cursor ? gt(linkWalletConnections.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(linkWalletConnections.id))
      .limit(100);
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      cursor = row.id;
      if (!row.encryptedCredentials) {
        throw new Error("Invalid wallet credential envelope");
      }
      const credentials = migrationCredentialsSchema.parse(
        JSON.parse(await decryptStoredSecretValue(row.encryptedCredentials)),
      );
      if (
        (credentials.scope === undefined) !==
        (credentials.readOnly === undefined)
      ) {
        throw new Error("Incomplete wallet grant metadata");
      }
      yield {
        ...row,
        encryptedCredentials: row.encryptedCredentials,
        credentials,
      };
    }
  }
}

async function inventory() {
  const counts = { scanned: 0, current: 0, legacy: 0, revokedLegacy: 0 };
  for await (const connection of connections()) {
    counts.scanned++;
    if (connection.credentials.scope !== undefined) {
      counts.current++;
    } else if (connection.revokedAt) {
      counts.revokedLegacy++;
    } else {
      counts.legacy++;
    }
  }
  return counts;
}

async function migrate(counts: {
  refreshesStarted: number;
  refreshed: number;
  revoked: number;
  changedConcurrently: number;
}) {
  for await (const connection of connections()) {
    if (connection.credentials.scope !== undefined) {
      continue;
    }
    const sameAuthorization = and(
      eq(linkWalletConnections.id, connection.id),
      eq(linkWalletConnections.authorizationId, connection.authorizationId),
    );
    const sameCredentials = and(
      sameAuthorization,
      eq(
        linkWalletConnections.encryptedCredentials,
        connection.encryptedCredentials,
      ),
    );
    if (connection.revokedAt) {
      await revokeLinkToken(
        connection.credentials.refreshToken,
        AbortSignal.timeout(15_000),
      );
      const cleared = await db()
        .update(linkWalletConnections)
        .set({ encryptedCredentials: null, revocationConfirmedAt: nowDate() })
        .where(and(sameCredentials, isNotNull(linkWalletConnections.revokedAt)))
        .returning({ id: linkWalletConnections.id });
      if (cleared.length) {
        counts.revoked++;
      } else {
        counts.changedConcurrently++;
      }
      continue;
    }

    // Match the online refresh lifecycle: consume a rotating token exactly once
    // before calling Link. An uncertain provider result must never be replayed.
    const claimed = await db()
      .update(linkWalletConnections)
      .set({ encryptedCredentials: null })
      .where(and(sameCredentials, isNull(linkWalletConnections.revokedAt)))
      .returning({ id: linkWalletConnections.id });
    if (!claimed.length) {
      counts.changedConcurrently++;
      continue;
    }
    counts.refreshesStarted++;
    const refreshed = await linkTokenRequest(
      {
        grant_type: "refresh_token",
        refresh_token: connection.credentials.refreshToken,
      },
      AbortSignal.timeout(15_000),
    );
    const credentials = linkCredentialsSchema.parse({
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: now() + refreshed.expires_in * 1000,
      scope: refreshed.scope,
      authorizationDetails: refreshed.authorization_details,
      // Every writer of the complete legacy shape validated payment consent.
      readOnly: false,
    });
    const encryption = await settleIncludingAbort(
      encryptStoredSecretValue(JSON.stringify(credentials)),
    );
    if (!encryption.ok) {
      await revokeLinkToken(
        refreshed.refresh_token,
        AbortSignal.timeout(15_000),
      );
      throw new Error("Could not encrypt refreshed wallet credentials");
    }
    const encryptedCredentials = encryption.value;
    const saved = await db()
      .update(linkWalletConnections)
      .set({ encryptedCredentials })
      .where(
        and(
          sameAuthorization,
          isNull(linkWalletConnections.encryptedCredentials),
          isNull(linkWalletConnections.revokedAt),
        ),
      )
      .returning({ id: linkWalletConnections.id });
    if (saved.length) {
      counts.refreshed++;
      continue;
    }

    // A disconnect or replacement owns the row now. Keep a disconnected
    // authorization's rotated token available for revocation recovery, without
    // replacing a newer grant or ever changing the wallet's owner.
    await db()
      .update(linkWalletConnections)
      .set({ encryptedCredentials })
      .where(
        and(
          sameAuthorization,
          isNull(linkWalletConnections.encryptedCredentials),
          isNotNull(linkWalletConnections.revokedAt),
        ),
      );
    await revokeLinkToken(refreshed.refresh_token, AbortSignal.timeout(15_000));
    await db()
      .update(linkWalletConnections)
      .set({ encryptedCredentials: null, revocationConfirmedAt: nowDate() })
      .where(
        and(
          sameAuthorization,
          eq(linkWalletConnections.encryptedCredentials, encryptedCredentials),
          isNotNull(linkWalletConnections.revokedAt),
        ),
      );
    counts.changedConcurrently++;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      report: { type: "string" },
    },
    allowPositionals: false,
  });
  // Validate every retained envelope before making any changes. Both scans
  // include revoked and historical agent-scoped grants, not just active users.
  const before = await inventory();
  const changes = values.migrate
    ? { refreshesStarted: 0, refreshed: 0, revoked: 0, changedConcurrently: 0 }
    : null;
  const outcome = await settleIncludingAbort(
    (async () => {
      if (changes) {
        await migrate(changes);
      }
      const after = values.migrate ? await inventory() : before;
      if (values.migrate && after.legacy + after.revokedLegacy > 0) {
        throw new Error("Legacy wallet credentials remain");
      }
      return after;
    })(),
  );
  const result = {
    mode: values.migrate ? "migrate" : "dry-run",
    completed: outcome.ok,
    before,
    changes,
    after: outcome.ok ? outcome.value : null,
  };
  if (values.report) {
    await writeFile(values.report, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!outcome.ok) {
    throw new Error("Wallet credential migration did not complete");
  }
}

const result = await settleIncludingAbort(main());
const closed = await settleIncludingAbort(closeDbPool());
if (!result.ok || !closed.ok) {
  // Database/provider/validation errors can contain tokens or row contents.
  // The operator emits only aggregates and this fixed failure diagnostic.
  process.stderr.write(
    "Link wallet grant migration failed; API promotion must stop. Consumed refresh tokens must not be retried; affected wallets may require reconnection.\n",
  );
  process.exitCode = 1;
}

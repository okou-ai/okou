import { createHash } from "node:crypto";
import type { Client } from "pg";
import { array, number, object, string } from "zod";

const rowSchema = object({
  id: string().uuid(),
  providerId: string().uuid(),
  orgId: string(),
  userId: string(),
  authMethod: string().nullable(),
  externalId: string().nullable(),
  accountVersion: string(),
  secretId: string().uuid().nullable(),
  encryptedValue: string().nullable(),
});
type Row = ReturnType<typeof rowSchema.parse>;
type Candidate = Omit<Row, "secretId" | "encryptedValue"> & {
  secretId: string;
  encryptedValue: string;
  value: string;
};

export class BackfillError extends Error {}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function audit(
  client: Client,
  decrypt: (encrypted: string) => Promise<string>,
) {
  const result = await client.query(`
    SELECT a.id, a.model_provider_id AS "providerId", a.org_id AS "orgId",
      a.user_id AS "userId", a.auth_method AS "authMethod",
      a.external_account_id AS "externalId", a.updated_at::text AS "accountVersion",
      s.id AS "secretId", s.encrypted_value AS "encryptedValue"
    FROM model_provider_accounts a
    LEFT JOIN model_provider_account_secrets s
      ON s.model_provider_account_id = a.id AND s.name = 'CHATGPT_ACCOUNT_ID'
    WHERE a.type = 'codex-oauth-token'
    ORDER BY a.id LIMIT 1001
  `);
  const rows = array(rowSchema).parse(result.rows);
  if (rows.length > 1000) {
    throw new BackfillError("AccountLimitExceeded");
  }
  const candidates: Candidate[] = [];
  const identities = new Set<string>();
  let matching = 0;
  for (const row of rows) {
    if (!row.secretId || !row.encryptedValue) {
      throw new BackfillError("MissingAccountIdSecret");
    }
    const value = await decrypt(row.encryptedValue);
    if (!value || value.trim() !== value || value.length > 255) {
      throw new BackfillError("InvalidAccountId");
    }
    const identity = digest(JSON.stringify([row.providerId, value]));
    if (identities.has(identity)) {
      throw new BackfillError("DuplicateIdentity");
    }
    identities.add(identity);
    if (row.externalId === null) {
      candidates.push({
        ...row,
        secretId: row.secretId,
        encryptedValue: row.encryptedValue,
        value,
      });
    } else if (row.externalId === value) {
      matching++;
    } else {
      throw new BackfillError("ExistingIdentityMismatch");
    }
  }
  const planSha256 = digest(
    JSON.stringify(
      candidates.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        orgId: row.orgId,
        userId: row.userId,
        authMethod: row.authMethod,
        accountVersion: row.accountVersion,
        secretId: row.secretId,
        ciphertextSha256: digest(row.encryptedValue),
        identitySha256: digest(row.value),
      })),
    ),
  );
  return { scanned: rows.length, matching, candidates, planSha256 };
}

export async function apply(client: Client, candidates: readonly Candidate[]) {
  if (candidates.length === 0) {
    return 0;
  }
  // One statement; a final count guard rolls back every write if a source
  // changed, including an UPDATE recheck after a concurrent row change.
  const result = await client.query(
    `WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
        id uuid, "providerId" uuid, "orgId" text, "userId" text,
        "authMethod" text, "accountVersion" text, "secretId" uuid,
        "encryptedValue" text, value text)
    ), eligible AS MATERIALIZED (
      SELECT r.* FROM requested r
      JOIN model_provider_accounts a ON a.id = r.id
      JOIN model_provider_account_secrets s ON s.id = r."secretId"
      WHERE a.type = 'codex-oauth-token' AND a.external_account_id IS NULL
        AND a.model_provider_id = r."providerId"
        AND a.org_id = r."orgId" AND a.user_id = r."userId"
        AND a.auth_method IS NOT DISTINCT FROM r."authMethod"
        AND a.updated_at::text = r."accountVersion"
        AND s.model_provider_account_id = a.id AND s.name = 'CHATGPT_ACCOUNT_ID'
        AND s.encrypted_value = r."encryptedValue"
    ), written AS (
      UPDATE model_provider_accounts a
      SET external_account_id = e.value, updated_at = CURRENT_TIMESTAMP
      FROM eligible e
      WHERE a.id = e.id AND a.external_account_id IS NULL
        AND a.model_provider_id = e."providerId"
        AND a.org_id = e."orgId" AND a.user_id = e."userId"
        AND a.auth_method IS NOT DISTINCT FROM e."authMethod"
        AND a.updated_at::text = e."accountVersion"
        AND (SELECT count(*) FROM eligible) = (SELECT count(*) FROM requested)
      RETURNING a.id
    )
    SELECT CASE WHEN (SELECT count(*) FROM written) = (SELECT count(*) FROM requested)
      THEN (SELECT count(*)::int FROM written)
      ELSE ('codex-id-source-changed-' || (SELECT count(*) FROM written))::int
      END AS updated`,
    [JSON.stringify(candidates)],
  );
  return object({ updated: number().int().nonnegative() }).parse(result.rows[0])
    .updated;
}

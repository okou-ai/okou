#!/usr/bin/env tsx

/**
 * Backfill the first custom model gateway connection.
 *
 * Usage (from turbo/packages/db):
 *   pnpm exec tsx scripts/migrations/010-custom-model-gateways/backfill.ts
 *   pnpm exec tsx scripts/migrations/010-custom-model-gateways/backfill.ts --migrate
 *   pnpm exec tsx scripts/migrations/010-custom-model-gateways/backfill.ts \
 *     --migrate --cleanup-retired-providers
 *
 * Environment:
 *   DATABASE_URL — Required
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import postgres from "postgres";

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
    "cleanup-retired-providers": { type: "boolean", default: false },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;
const CLEANUP_RETIRED_PROVIDERS = args["cleanup-retired-providers"];

const GEO = {
  orgId: "org_3DNXaE9LpgT9NVtnEUaGowzQnxF",
  legacyProviderId: "e9409896-fd2e-41f2-bec8-2ff8b9913e3e",
  policyIds: [
    "e46a4dbc-8dbe-473e-8ad6-d36d6a3943af",
    "a4df56dc-cd9a-4e78-8fdc-60b1e7fa0df5",
  ],
} as const;

const RETIRED_PROVIDERS = [
  {
    orgId: "org_3BItNtgzSxTcqq8CebMuNpDIMao",
    providerId: "933f3d7f-89d6-44ba-a8ad-14af7ce00eb3",
    type: "openrouter-api-key",
  },
  {
    orgId: "org_3EGXNoeXnGxrHnC3WuAyZacg4SP",
    providerId: "c2a65dc4-8115-4d3b-ae0c-3968d12c14c2",
    type: "openrouter-api-key",
  },
  {
    orgId: "org_3F6dxxLyhK1QTudsAWmobwpYQsn",
    providerId: "ef2d2043-e42a-4526-9f2f-c6248f72a068",
    type: "openrouter-api-key",
  },
  {
    orgId: "org_3FwV93qIHtXZHqKHtc0szzHfLAl",
    providerId: "278e88cf-eeb0-4b0d-b76d-7c4d7dafaaf9",
    type: "openrouter-api-key",
  },
  {
    orgId: "org_3DYkThmpEgnHPTsMuXqUgeOYeoy",
    providerId: "25f10ab3-1fa1-4094-8789-79210e46d95c",
    type: "vercel-ai-gateway",
  },
] as const;

const VERCEL_MESSAGES_MAPPINGS = {
  "claude-fable-5": "anthropic/claude-fable-5",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-opus-4-8": "anthropic/claude-opus-4.8",
  "claude-opus-4-7": "anthropic/claude-opus-4.7",
  "claude-opus-4-6": "anthropic/claude-opus-4.6",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
} as const;

const VERCEL_RESPONSES_MAPPINGS = {
  "gpt-5.6-sol": "openai/gpt-5.6-sol",
  "gpt-5.6-terra": "openai/gpt-5.6-terra",
  "gpt-5.6-luna": "openai/gpt-5.6-luna",
  "gpt-5.5": "openai/gpt-5.5",
} as const;

interface LegacyProviderRow {
  readonly id: string;
  readonly secret_id: string | null;
}

interface IdRow {
  readonly id: string;
}

interface ReferenceCounts {
  readonly policies: number;
  readonly agents: number;
  readonly threads: number;
  readonly runs: number;
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

async function loadLegacyProvider(
  sql: postgres.Sql,
  args: {
    readonly orgId: string;
    readonly providerId: string;
    readonly type: string;
  },
): Promise<LegacyProviderRow | null> {
  const rows = await sql<LegacyProviderRow[]>`
    SELECT id, secret_id
    FROM model_providers
    WHERE id = ${args.providerId}
      AND org_id = ${args.orgId}
      AND type = ${args.type}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadReferenceCounts(
  sql: postgres.Sql,
  providerId: string,
): Promise<ReferenceCounts> {
  const rows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM org_model_policies
        WHERE model_provider_id = ${providerId}) AS policies,
      (SELECT COUNT(*)::int FROM zero_agents
        WHERE model_provider_id = ${providerId}) AS agents,
      (SELECT COUNT(*)::int FROM chat_threads
        WHERE model_provider_id = ${providerId}) AS threads,
      (SELECT COUNT(*)::int FROM zero_runs
        WHERE model_provider_id = ${providerId}) AS runs
  `;
  const row = rows[0];
  return {
    policies: numberValue(row?.policies),
    agents: numberValue(row?.agents),
    threads: numberValue(row?.threads),
    runs: numberValue(row?.runs),
  };
}

async function reportGeo(sql: postgres.Sql): Promise<void> {
  const provider = await loadLegacyProvider(sql, {
    orgId: GEO.orgId,
    providerId: GEO.legacyProviderId,
    type: "vercel-ai-gateway",
  });
  const policies = await sql`
    SELECT id, model, model_provider_id, model_provider_surface_id
    FROM org_model_policies
    WHERE id IN ${sql(GEO.policyIds)}
    ORDER BY id
  `;
  const connections = provider?.secret_id
    ? await sql`
        SELECT id
        FROM model_provider_connections
        WHERE org_id = ${GEO.orgId}
          AND secret_id = ${provider.secret_id}
      `
    : [];

  console.log(`geo legacy provider present: ${provider !== null}`);
  console.log(`geo target policies present: ${policies.length}`);
  console.log(`geo gateway connection present: ${connections.length === 1}`);
}

async function ensureGeoConnection(sql: postgres.Sql): Promise<void> {
  const provider = await loadLegacyProvider(sql, {
    orgId: GEO.orgId,
    providerId: GEO.legacyProviderId,
    type: "vercel-ai-gateway",
  });
  if (!provider) {
    throw new Error("Expected geo legacy Vercel provider");
  }
  if (!provider.secret_id) {
    throw new Error("Expected geo legacy Vercel provider secret");
  }

  let connectionRows = await sql<IdRow[]>`
    SELECT id
    FROM model_provider_connections
    WHERE org_id = ${GEO.orgId}
      AND secret_id = ${provider.secret_id}
    LIMIT 1
  `;
  if (connectionRows.length === 0) {
    connectionRows = await sql<IdRow[]>`
      INSERT INTO model_provider_connections (
        id,
        org_id,
        display_name,
        secret_id
      )
      VALUES (
        ${randomUUID()},
        ${GEO.orgId},
        'Vercel AI Gateway',
        ${provider.secret_id}
      )
      ON CONFLICT (secret_id) DO NOTHING
      RETURNING id
    `;
    if (connectionRows.length === 0) {
      connectionRows = await sql<IdRow[]>`
        SELECT id
        FROM model_provider_connections
        WHERE secret_id = ${provider.secret_id}
        LIMIT 1
      `;
    }
  }
  const connection = connectionRows[0];
  if (!connection) {
    throw new Error("Expected geo custom gateway connection");
  }

  await sql`
    INSERT INTO model_provider_surfaces (
      id,
      connection_id,
      protocol,
      api_base_url,
      auth_header_name,
      auth_header_template,
      model_mappings
    )
    VALUES (
      ${randomUUID()},
      ${connection.id},
      'anthropic-messages',
      'https://ai-gateway.vercel.sh',
      'Authorization',
      'Bearer {{secret}}',
      ${JSON.stringify(VERCEL_MESSAGES_MAPPINGS)}::jsonb
    )
    ON CONFLICT (connection_id, protocol) DO NOTHING
  `;
  await sql`
    INSERT INTO model_provider_surfaces (
      id,
      connection_id,
      protocol,
      api_base_url,
      auth_header_name,
      auth_header_template,
      model_mappings
    )
    VALUES (
      ${randomUUID()},
      ${connection.id},
      'openai-responses',
      'https://ai-gateway.vercel.sh/v1',
      'Authorization',
      'Bearer {{secret}}',
      ${JSON.stringify(VERCEL_RESPONSES_MAPPINGS)}::jsonb
    )
    ON CONFLICT (connection_id, protocol) DO NOTHING
  `;

  const [messagesSurface] = await sql<IdRow[]>`
    SELECT id
    FROM model_provider_surfaces
    WHERE connection_id = ${connection.id}
      AND protocol = 'anthropic-messages'
    LIMIT 1
  `;
  if (!messagesSurface) {
    throw new Error("Expected geo Anthropic Messages surface");
  }

  const updated = await sql`
    UPDATE org_model_policies
    SET
      model_provider_id = NULL,
      model_provider_surface_id = ${messagesSurface.id},
      updated_at = NOW()
    WHERE id IN ${sql(GEO.policyIds)}
      AND org_id = ${GEO.orgId}
      AND model_provider_id = ${GEO.legacyProviderId}
    RETURNING id
  `;
  console.log(`geo policies migrated in this run: ${updated.length}`);
}

async function reportRetiredProviders(sql: postgres.Sql): Promise<void> {
  for (const target of RETIRED_PROVIDERS) {
    const provider = await loadLegacyProvider(sql, {
      orgId: target.orgId,
      providerId: target.providerId,
      type: target.type,
    });
    const references = await loadReferenceCounts(sql, target.providerId);
    console.log(
      `retired provider ${target.providerId}: present=${provider !== null} ` +
        `policies=${references.policies} agents=${references.agents} ` +
        `threads=${references.threads} runs=${references.runs}`,
    );
  }
}

async function cleanupRetiredProviders(sql: postgres.Sql): Promise<void> {
  for (const target of RETIRED_PROVIDERS) {
    const deleted = await sql<LegacyProviderRow[]>`
      DELETE FROM model_providers
      WHERE id = ${target.providerId}
        AND org_id = ${target.orgId}
        AND type = ${target.type}
      RETURNING id, secret_id
    `;
    const provider = deleted[0];
    if (!provider) {
      console.log(`retired provider already absent: ${target.providerId}`);
      continue;
    }
    if (!provider.secret_id) {
      console.log(
        `retired provider deleted without a secret: ${target.providerId}`,
      );
      continue;
    }

    const deletedSecrets = await sql`
      DELETE FROM secrets
      WHERE id = ${provider.secret_id}
        AND NOT EXISTS (
          SELECT 1
          FROM model_providers
          WHERE secret_id = ${provider.secret_id}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM model_provider_connections
          WHERE secret_id = ${provider.secret_id}
        )
      RETURNING id
    `;
    console.log(
      `retired provider deleted: ${provider.id}; ` +
        `orphaned secret deleted=${deletedSecrets.length === 1}`,
    );
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (CLEANUP_RETIRED_PROVIDERS && DRY_RUN) {
    throw new Error("--cleanup-retired-providers requires --migrate");
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    console.log("=== Custom Model Gateway Backfill ===");
    console.log(
      `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
    );
    await reportGeo(sql);
    await reportRetiredProviders(sql);
    if (DRY_RUN) {
      return;
    }

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0361; new non-billing transactions are prohibited.
    await sql.begin(async (transaction) => {
      await ensureGeoConnection(transaction);
      if (CLEANUP_RETIRED_PROVIDERS) {
        await cleanupRetiredProviders(transaction);
      }
    });
  } finally {
    await sql.end();
  }
}

await main();

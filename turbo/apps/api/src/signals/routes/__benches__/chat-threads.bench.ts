import { createHash, randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";
import { delay } from "msw";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import { connectors } from "@okouai/db/schema/connector";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { test } from "vitest";
import {
  chatThreadByIdContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { connectorsMainContract } from "@okouai/api-contracts/contracts/connectors";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { z } from "zod";
import { executeRawRows } from "../../../lib/db-raw-rows";
import { mockEnv } from "../../../lib/env";
import { setupApp } from "../../../__tests__/test-helpers";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { nowDate } from "../../../lib/time";
import { appendChatThreadEvent } from "../../services/chat-thread-event.service";
import {
  connectorCatalogExecutableCapabilityState,
  persistConnectorCatalogCompatibility,
} from "../../services/connector-catalog-compatibility.service";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { encodeConnectorCatalogSnapshot } from "@okouai/connectors/connector-catalog/artifacts/loader";
import { connectorCatalogSource } from "../../services/connector-catalog-source";
import { currentConnectorCatalogValidatorIdentity } from "../../services/connector-catalog-validator-authority";
import { normalizeRunMetadata } from "../../services/agent-run-metadata-write.service";
import { seedUserModelProvider$ } from "./helpers/model-providers";
import { createBenchHttpHandlers, MOCK_R2_LIST_DELAY_MS } from "./helpers/http";
import { seedOrgMembership$ } from "../__tests__/helpers/org-membership";
import { createRouteMocks } from "../__tests__/helpers/route-test";
import { billingStatusRoutes } from "../billing-status";
import { chatThreadRoutes } from "../chat-threads";
import { connectorsRoutes } from "../connectors";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { orgReadRoutes } from "../org-read";
import { userPreferencesRoutes } from "../user-preferences";
import { ensureOrgMetadataPlanEntitlement } from "../../services/org-plan-entitlements.service";

const personalModelProvidersMainTestRoutes = Object.freeze([
  ...meModelProvidersListRoutes,
  ...meModelProvidersUpsertRoutes,
]);

// HTTP-level benchmarks for side-effect-free GET routes that showed elevated
// P90 in production traces. All cases share one seeded DB fixture and only issue
// GET requests during benchmark iterations, so samples do not mutate state or
// require resetting the database between cases.
//
// Fixture seeding runs lazily during the first measurement and is reused by
// all six measurements within the same test lifecycle.
//
// The fixture bulks up agent_runs / chat_events and the
// user-visible GET data sets well past planner cross-over so Postgres uses the
// same index-driven paths production hits. With tiny fixtures the planner picks
// seq scans and the per-query overhead this bench needs to measure disappears.

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

const TARGET_RUN_COUNT = 200;
const TARGET_MESSAGES_PER_RUN = 3;
const BACKGROUND_THREAD_COUNT = 200;
const BACKGROUND_RUNS_PER_THREAD = 50;
const BULK_INSERT_CHUNK = 500;
const TARGET_ATTACHMENT_COUNT = 6;
const STATUSES = ["completed", "completed", "failed", "running"] as const;
const queryPlanRowSchema = z.object({ "QUERY PLAN": z.string() });
const BENCH_CONNECTOR_CATALOG_VERSION = "bench-api-v1";
const BENCH_CONNECTOR_CATALOG_KEY =
  `connectors/v${String(SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION)}/` +
  `releases/${BENCH_CONNECTOR_CATALOG_VERSION}/catalog.json`;

const chatThreadClient = setupApp({ context, routes: chatThreadRoutes })(
  chatThreadByIdContract,
);
const connectorsClient = setupApp({ context, routes: connectorsRoutes })(
  connectorsMainContract,
);
const userPreferencesClient = setupApp({
  context,
  routes: userPreferencesRoutes,
})(userPreferencesContract);
const billingStatusClient = setupApp({
  context,
  routes: billingStatusRoutes,
})(billingStatusContract);
const orgClient = setupApp({ context, routes: orgReadRoutes })(orgContract);
const personalModelProvidersClient = setupApp({
  context,
  routes: personalModelProvidersMainTestRoutes,
})(personalModelProvidersMainContract);

interface BenchChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

function benchCatalogConnector(args: {
  readonly connectorSlug: string;
  readonly label: string;
  readonly iconKey: string;
  readonly secretName: string;
}): ConnectorCatalogArtifactConnector {
  return {
    slug: args.connectorSlug,
    label: args.label,
    description: `${args.label} connector used by the API benchmark`,
    category: "benchmark",
    generation: [],
    tags: ["benchmark"],
    authMethods: [
      {
        id: "api-token",
        label: "API token",
        description: null,
        visible: true,
        storage: {
          version: 1,
          secrets: [args.secretName],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: [
            {
              privateName: args.secretName,
              publicId: "credential",
              label: "Credential",
              required: true,
              placeholder: null,
              storage: "secret",
            },
          ],
        },
        access: {
          kind: "static",
          envBindings: {
            BENCH_CONNECTOR_TOKEN: `$secrets.${args.secretName}`,
          },
        },
        revoke: { kind: "none" },
      },
    ],
    icon: {
      key: args.iconKey,
      invertInDarkMode: false,
    },
    skill: { kind: "none" },
    firewall: { kind: "none" },
  };
}

const BENCH_CONNECTOR_CATALOG = {
  artifactSchemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  catalogVersion: BENCH_CONNECTOR_CATALOG_VERSION,
  categoryMetadata: {
    categories: [
      {
        id: "benchmark",
        label: "Benchmark",
        menuLabel: "Benchmark",
        groupId: null,
      },
    ],
    groups: [],
  },
  connectors: [
    benchCatalogConnector({
      connectorSlug: "benchmark-github",
      label: "GitHub",
      iconKey:
        "views/zero-page/components/settings/icons/github-4a739019d805.svg",
      secretName: "GITHUB_TOKEN",
    }),
    benchCatalogConnector({
      connectorSlug: "benchmark-notion",
      label: "Notion",
      iconKey:
        "views/zero-page/components/settings/icons/notion-beeb509915a9.svg",
      secretName: "NOTION_TOKEN",
    }),
    benchCatalogConnector({
      connectorSlug: "benchmark-slack",
      label: "Slack",
      iconKey:
        "views/zero-page/components/settings/icons/slack-198390069136.svg",
      secretName: "SLACK_TOKEN",
    }),
  ],
} satisfies ConnectorCatalogArtifact;

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function seedBenchConnectorCatalog(): Promise<void> {
  const rawBytes = Buffer.from(`${JSON.stringify(BENCH_CONNECTOR_CATALOG)}\n`);
  const catalogDigest = sha256Digest(rawBytes);
  const catalogGzip = encodeConnectorCatalogSnapshot(rawBytes);
  const source = connectorCatalogSource();
  const capability = connectorCatalogExecutableCapabilityState();
  const activatedAt = nowDate();
  const db = store.set(writeDb$);
  const syncStateValues = {
    revision: 1,
    lastObservedCatalogVersion: BENCH_CONNECTOR_CATALOG_VERSION,
    lastObservedCatalogKey: BENCH_CONNECTOR_CATALOG_KEY,
    lastObservedCatalogDigest: catalogDigest,
    lastObservedPointerEtag: null,
    lastAttemptAt: activatedAt,
    lastAttemptOutcome: "accepted" as const,
    lastAttemptReusedCachedRejection: false,
    lastSuccessAt: activatedAt,
    lastFailureCode: null,
    lastRejectedCatalogVersion: null,
    lastRejectedCatalogKey: null,
    lastRejectedCatalogDigest: null,
    lastRejectedPointerEtag: null,
    lastRejectedFailureCode: null,
    lastRejectedBackendVersion: null,
    lastRejectedBuildCommitSha: null,
  };
  const snapshotValues = {
    catalogVersion: BENCH_CONNECTOR_CATALOG_VERSION,
    catalogKey: BENCH_CONNECTOR_CATALOG_KEY,
    catalogDigest,
    catalogRawSize: rawBytes.byteLength,
    catalogGzip,
    activatedAt,
  };

  await db.transaction(async (tx) => {
    await tx
      .insert(connectorCatalogSyncState)
      .values({
        sourceId: source.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ...syncStateValues,
      })
      .onConflictDoUpdate({
        target: [
          connectorCatalogSyncState.sourceId,
          connectorCatalogSyncState.schemaVersion,
        ],
        set: syncStateValues,
      });
    await tx
      .insert(connectorCatalogActiveSnapshot)
      .values({
        sourceId: source.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ...snapshotValues,
      })
      .onConflictDoUpdate({
        target: [
          connectorCatalogActiveSnapshot.sourceId,
          connectorCatalogActiveSnapshot.schemaVersion,
        ],
        set: snapshotValues,
      });
    await persistConnectorCatalogCompatibility({
      db: tx,
      sourceId: source.sourceId,
      identity: {
        catalogVersion: BENCH_CONNECTOR_CATALOG_VERSION,
        catalogDigest,
      },
      artifact: BENCH_CONNECTOR_CATALOG,
      capability,
      validator: currentConnectorCatalogValidatorIdentity(),
    });
  });
}

async function chunkedInsert<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BULK_INSERT_CHUNK) {
    await insert(rows.slice(i, i + BULK_INSERT_CHUNK));
  }
}

function markdownLorem(runIndex: number, messageIndex: number): string {
  const blocks = [
    `# Benchmark note ${String(runIndex)}.${String(messageIndex)}`,
    "This paragraph intentionally uses markdown-shaped content so response serialization has production-like payload weight.",
    "## Observations",
    "- The endpoint should parse and return repeated chat messages.",
    "- Inline code such as `pnpm -F api bench` should remain plain text.",
    "- Links like [docs](https://example.com/docs) should not trigger network work.",
    "",
    "```ts",
    `const sample = { run: ${String(runIndex)}, message: ${String(messageIndex)}, ok: true };`,
    "console.log(sample);",
    "```",
    "",
    "> Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    "",
  ];
  return blocks.join("\n").repeat(6);
}

function targetAttachmentId(index: number): string {
  return `bench-attachment-${String(index).padStart(2, "0")}`;
}

function benchUserMessage(
  content: string,
  attachmentId: string | undefined,
): UserMessageDocument {
  return {
    version: 1,
    parts: [
      ...(attachmentId
        ? [
            {
              type: "file" as const,
              fileId: attachmentId,
              filenameSnapshot: "bench-attachment.md",
              contentType: "text/markdown",
            },
          ]
        : []),
      { type: "text", text: content },
    ],
  };
}

function commandName(command: unknown): string {
  return command instanceof Object && "constructor" in command
    ? command.constructor.name
    : "";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command) ||
    typeof command.input !== "object" ||
    command.input === null
  ) {
    return {};
  }
  return command.input as Record<string, unknown>;
}

function installBenchExternalMocks(): void {
  mockEnv("S3_FORCE_PATH_STYLE", "true");
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (commandName(command) !== "ListObjectsV2Command") {
      return {};
    }

    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
    if (bucket !== "test-user-artifacts") {
      return {};
    }

    await delay(MOCK_R2_LIST_DELAY_MS);
    return {
      Contents: [
        {
          Key: `${prefix}bench-attachment.md`,
          LastModified: new Date("2026-05-25T00:00:00.000Z"),
          Size: 4096,
        },
      ],
    };
  });
  server.use(...createBenchHttpHandlers());
}

async function seedBackgroundLoad(): Promise<void> {
  const db = store.set(writeDb$);
  const bgUserId = `bg_user_${randomUUID()}`;
  const bgOrgId = `bg_org_${randomUUID()}`;
  const bgAgentId = randomUUID();

  await db.insert(agents).values({
    id: bgAgentId,
    orgId: bgOrgId,
    owner: bgUserId,
    name: "bench-bg",
  });

  const threadIds: string[] = [];
  const sessionIds: string[] = [];
  for (let i = 0; i < BACKGROUND_THREAD_COUNT; i++) {
    threadIds.push(randomUUID());
    sessionIds.push(randomUUID());
  }

  await chunkedInsert(
    threadIds.map((id) => {
      return {
        id,
        userId: bgUserId,
        agentId: bgAgentId,
        title: "bg",
      };
    }),
    (chunk) => {
      return db.insert(chatThreads).values(chunk);
    },
  );
  await chunkedInsert(
    sessionIds.map((id) => {
      return {
        id,
        userId: bgUserId,
        orgId: bgOrgId,
        agentId: bgAgentId,
      };
    }),
    (chunk) => {
      return db.insert(agentSessions).values(chunk);
    },
  );

  const runRows: (typeof agentRuns.$inferInsert)[] = [];
  for (let t = 0; t < BACKGROUND_THREAD_COUNT; t++) {
    for (let r = 0; r < BACKGROUND_RUNS_PER_THREAD; r++) {
      const runId = randomUUID();
      const metadata = normalizeRunMetadata({
        triggerSource: "test",
        chatThreadId: threadIds[t]!,
      });
      runRows.push({
        id: runId,
        userId: bgUserId,
        orgId: bgOrgId,
        sessionId: sessionIds[t]!,
        status: STATUSES[r % STATUSES.length]!,
        prompt: "bg",
        ...metadata,
      });
    }
  }
  await chunkedInsert(runRows, (chunk) => {
    return db.insert(agentRuns).values(chunk);
  });
}

async function seedBenchChatThread(): Promise<BenchChatThreadFixture> {
  const db = store.set(writeDb$);
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const agentId = randomUUID();
  const threadId = randomUUID();
  const title = "bench";

  await db.insert(agents).values({
    id: agentId,
    orgId,
    owner: userId,
    name: `agent-${agentId.slice(0, 8)}`,
  });
  await db.insert(chatThreads).values({
    id: threadId,
    userId,
    agentId,
    title,
  });
  await db.transaction(async (tx) => {
    await appendChatThreadEvent(tx, {
      userId,
      orgId,
      chatThreadId: threadId,
      kind: "created",
      agentId,
      title,
    });
  });

  return { userId, orgId, agentId, threadId };
}

async function seedTargetThreadRuns(
  fixture: BenchChatThreadFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentId: fixture.agentId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("target session insert returned no row");
  }

  const runRows: (typeof agentRuns.$inferInsert)[] = [];
  const eventRows: {
    chatThreadId: string;
    runId: string;
    eventType: "input.prompt" | "output.message";
    contextType?: "web";
    payload: { content: string } | { userMessage: UserMessageDocument };
    sequenceNumber: number;
    seqId: number;
    createdAt: Date;
  }[] = [];
  const now = nowDate().getTime();
  for (let i = 0; i < TARGET_RUN_COUNT; i++) {
    const runId = randomUUID();
    const metadata = normalizeRunMetadata({
      triggerSource: "test",
      chatThreadId: fixture.threadId,
    });
    runRows.push({
      id: runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      sessionId: session.id,
      status: STATUSES[i % STATUSES.length]!,
      prompt: `bench prompt ${String(i)}`,
      ...metadata,
    });
    for (let m = 0; m < TARGET_MESSAGES_PER_RUN; m++) {
      const latestAttachmentStart = TARGET_RUN_COUNT - TARGET_ATTACHMENT_COUNT;
      const attachmentId =
        m === 0 && i >= latestAttachmentStart
          ? targetAttachmentId(i - latestAttachmentStart)
          : undefined;
      const content = markdownLorem(i, m);
      const userMessage =
        m === 0 ? benchUserMessage(content, attachmentId) : undefined;
      eventRows.push({
        chatThreadId: fixture.threadId,
        runId,
        eventType: m === 0 ? "input.prompt" : "output.message",
        sequenceNumber: m,
        seqId: i * TARGET_MESSAGES_PER_RUN + m + 1,
        ...(userMessage !== undefined
          ? {
              contextType: "web",
              payload: { userMessage },
            }
          : { payload: { content } }),
        createdAt: new Date(now + i * 1000 + m),
      });
    }
  }
  await chunkedInsert(runRows, (chunk) => {
    return db.insert(agentRuns).values(chunk);
  });
  await chunkedInsert(eventRows, (chunk) => {
    return db.insert(chatEvents).values(chunk);
  });
  await db
    .update(chatThreads)
    .set({ lastChatEventSeqId: eventRows.length })
    .where(eq(chatThreads.id, fixture.threadId));
}

async function seedSideEffectFreeGetData(
  fixture: BenchChatThreadFixture,
): Promise<void> {
  const db = store.set(writeDb$);

  await store.set(
    seedOrgMembership$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
      slug: "bench-api",
      name: "Bench API",
    },
    context.signal,
  );

  await db.transaction(async (tx) => {
    const metadataRows = await tx
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId: fixture.orgId,
        credits: 125_000,
        tier: "pro",
        stripeCustomerId: `cus_${randomUUID()}`,
        stripeSubscriptionId: `sub_${randomUUID()}`,
        subscriptionStatus: "active",
        currentPeriodEnd: new Date("2099-01-01T00:00:00.000Z"),
      })
      .returning({
        orgId: orgMetadataCanonicalWrites.orgId,
        tier: orgMetadataCanonicalWrites.tier,
      });
    for (const metadata of metadataRows) {
      await ensureOrgMetadataPlanEntitlement(tx, metadata);
    }
  });
  await db.insert(creditExpiresRecord).values({
    orgId: fixture.orgId,
    source: "subscription_renewal",
    amount: 20_000,
    remaining: 18_000,
    expiresAt: new Date("2099-02-01T00:00:00.000Z"),
    stripeInvoiceId: `inv_${randomUUID()}`,
  });
  await db.insert(orgMembersMetadata).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    timezone: "America/Los_Angeles",
    pinnedAgentIds: [fixture.agentId],
    sendMode: "cmd-enter",
    captureNetworkBodiesRemaining: 3,
  });
  await db.insert(connectors).values([
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "benchmark-github",
      authMethod: "api-token",
      storageVersion: 1,
      externalId: "bench-github",
      externalUsername: "bench-github",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "benchmark-slack",
      authMethod: "api-token",
      storageVersion: 1,
      externalId: "bench-slack",
      externalUsername: "bench-slack",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "benchmark-notion",
      authMethod: "api-token",
      storageVersion: 1,
      externalId: "bench-notion",
      externalUsername: "bench-notion",
    },
  ]);

  await store.set(
    seedUserModelProvider$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "codex-oauth-token",
      isDefault: true,
      secretName: "CODEX_OAUTH_TOKEN",
    },
    context.signal,
  );
  await store.set(
    seedUserModelProvider$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "claude-code-oauth-token",
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    },
    context.signal,
  );
}

async function logPlannerDiagnostic(
  fixture: BenchChatThreadFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.execute(sql`
    ANALYZE
      agent_runs,
      chat_threads,
      chat_events,
      connectors,
      org_metadata,
      org_members_metadata,
      model_providers,
      credit_expires_record
  `);
  const plan = await executeRawRows(
    db,
    sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT agent_runs.id, agent_runs.status
      FROM agent_runs
      WHERE agent_runs.chat_thread_id = ${fixture.threadId}
        AND agent_runs.trigger_source IS NOT NULL
    `,
    queryPlanRowSchema,
  );
  const lines = plan.map((row) => {
    return row["QUERY PLAN"];
  });
  process.stdout.write(
    `\n[bench-explain] agent_runs WHERE chat_thread_id AND metadata present\n${lines.join("\n")}\n\n`,
  );
}

const ensureSeeded: () => Promise<BenchChatThreadFixture> = (() => {
  let cached: Promise<BenchChatThreadFixture> | undefined;
  return () => {
    cached ??= (async () => {
      installBenchExternalMocks();
      await seedBenchConnectorCatalog();
      const seeded = await seedBenchChatThread();
      await seedBackgroundLoad();
      await seedTargetThreadRuns(seeded);
      await seedSideEffectFreeGetData(seeded);
      await logPlannerDiagnostic(seeded);

      mocks.clerk.session(seeded.userId, seeded.orgId);
      const sanity = await chatThreadClient.get({
        params: { id: seeded.threadId },
        headers: { authorization: "Bearer clerk-session" },
      });
      if (sanity.status !== 200) {
        throw new Error(
          `sanity check failed: status=${String(sanity.status)} body=${JSON.stringify(sanity.body)}`,
        );
      }
      const connectorSanity = await connectorsClient.list({
        headers: { authorization: "Bearer clerk-session" },
      });
      if (connectorSanity.status !== 200) {
        throw new Error(
          `connector sanity check failed: status=${String(connectorSanity.status)} body=${JSON.stringify(connectorSanity.body)}`,
        );
      }
      const listedConnectorSlugs = new Set(
        connectorSanity.body.connectors.map((connector) => {
          return connector.slug;
        }),
      );
      const missingConnectorSlugs = BENCH_CONNECTOR_CATALOG.connectors
        .map((connector) => {
          return connector.slug;
        })
        .filter((connectorSlug) => {
          return !listedConnectorSlugs.has(connectorSlug);
        });
      if (missingConnectorSlugs.length > 0) {
        throw new Error(
          `connector sanity check omitted seeded connectors: ${missingConnectorSlugs.join(", ")}`,
        );
      }
      const providers = await personalModelProvidersClient.list({
        headers: { authorization: "Bearer clerk-session" },
      });
      if (providers.status !== 200) {
        throw new Error(
          `model provider sanity check failed: status=${String(providers.status)}`,
        );
      }
      const claude = providers.body.modelProviders.find((provider) => {
        return provider.type === "claude-code-oauth-token";
      });
      if (
        claude?.accountEmail !== "bench@example.test" ||
        claude.workspaceName !== "Bench API" ||
        claude.planType !== "pro" ||
        claude.subscriptionUsage?.fiveHour?.usedPercent !== 25 ||
        claude.subscriptionUsage.weekly?.usedPercent !== 10
      ) {
        throw new Error(
          "model provider sanity check omitted benchmark metadata",
        );
      }
      return seeded;
    })();
    return cached;
  };
})();

const benchOptions = { time: 5000, warmupIterations: 5, throws: true } as const;
const authHeaders = { authorization: "Bearer clerk-session" } as const;

// Six five-second measurements share one test-owned fixture and mock lifetime.
test(
  "bench side-effect-free GET API routes",
  { timeout: 120_000 },
  async ({ bench }) => {
    await bench("GET /api/chat-threads/:id", async () => {
      const fixture = await ensureSeeded();
      const response = await chatThreadClient.get({
        params: { id: fixture.threadId },
        headers: authHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    }).run(benchOptions);

    await bench("GET /api/connectors", async () => {
      await ensureSeeded();
      const response = await connectorsClient.list({ headers: authHeaders });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    }).run(benchOptions);

    await bench("GET /api/user-preferences", async () => {
      await ensureSeeded();
      const response = await userPreferencesClient.get({
        headers: authHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    }).run(benchOptions);

    await bench("GET /api/billing/status", async () => {
      await ensureSeeded();
      const response = await billingStatusClient.get({ headers: authHeaders });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    }).run(benchOptions);

    await bench("GET /api/org", async () => {
      await ensureSeeded();
      const response = await orgClient.get({ headers: authHeaders });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    }).run(benchOptions);

    await bench("GET /api/me/model-providers", async () => {
      await ensureSeeded();
      const response = await personalModelProvidersClient.list({
        headers: authHeaders,
      });
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
    }).run(benchOptions);
  },
);

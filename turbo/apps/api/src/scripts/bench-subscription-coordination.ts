/** Finite local SQL-coordination experiment, not an API correctness test.
 * Synthetic rows repeat the same coherent production service workload. HTTP
 * tests own behavior assertions. No credentials or SQL parameters are emitted. */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BasicTracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";
import { instrumentPgPool } from "../lib/db-instrumentation";
import { env } from "../lib/env";
import { settleIncludingAbort } from "../signals/utils";
import type { Db } from "../signals/external/db";
import { ApiDispatchTimingCollector } from "../signals/services/api-dispatch-timing.service";
import {
  captureActivePersonalModelProviderAccount,
  personalModelProviderAccountById,
  preparePersonalSubscriptionAdmission,
  readCoordinatedPersonalSubscriptionAccount,
  validatePersonalSubscriptionAdmission,
  type PersonalSubscriptionProviderType,
  type PreparedPersonalSubscriptionAdmission,
} from "../signals/services/model-provider-account.service";

const warmups = 50;
const repetitions = 100;
const inventorySize = process.argv.includes("--inventory=10") ? 10 : 1;
const stages = [
  "capture-concrete",
  "capture-null-logical",
  "capture-explicit-logical",
  "environment-database-fragment",
  "prepare-fresh-proof",
  "validate-final-locked",
] as const;
type Stage = (typeof stages)[number];

interface QueryObservation {
  readonly kind: string;
  readonly role: string;
  readonly ms: number;
  readonly end: number;
}

interface Statement {
  readonly query: string;
  readonly parameters: unknown[];
}

interface Sample {
  totalMs: number;
  readonly queries: QueryObservation[];
  readonly statements: Statement[];
  readonly timings: Record<string, number>;
}

class SampleTiming extends ApiDispatchTimingCollector {
  constructor(private readonly sample: Sample) {
    super();
  }

  override recordDuration(
    ...args: Parameters<ApiDispatchTimingCollector["recordDuration"]>
  ): void {
    this.sample.timings[args[0]] = args[2];
    super.recordDuration(...args);
  }
}

async function seed(database: Db, type: PersonalSubscriptionProviderType) {
  const owner = {
    orgId: `coordination-bench-${randomUUID()}`,
    userId: randomUUID(),
    type,
  };
  const providerId = randomUUID();
  const sourceId = randomUUID();
  const accountIds = [
    sourceId,
    ...Array.from({ length: inventorySize - 1 }, () => {
      return randomUUID();
    }),
  ];
  const authMethod = type === "claude-code-oauth-token" ? null : "auth_json";
  const names =
    type === "claude-code-oauth-token"
      ? ["CLAUDE_CODE_OAUTH_TOKEN"]
      : [
          "CHATGPT_ACCESS_TOKEN",
          "CHATGPT_REFRESH_TOKEN",
          "CHATGPT_ACCOUNT_ID",
          "CHATGPT_ID_TOKEN",
        ];
  // Coherent snapshots compare equal ciphertext without invoking KMS. These
  // synthetic cells are deliberately unusable as live provider credentials.
  const cells = names.map((name) => {
    return {
      id: randomUUID(),
      name,
      encryptedValue: `synthetic-coherent-cell:${name}`,
    };
  });
  await database.transaction(async (tx) => {
    await tx.insert(secrets).values(
      cells.map((cell) => {
        return { ...cell, ...owner, type: "model-provider" };
      }),
    );
    await tx.insert(modelProviders).values({
      ...owner,
      id: providerId,
      secretId: type === "claude-code-oauth-token" ? cells[0]?.id : null,
      authMethod,
    });
    await tx.insert(modelProviderAccounts).values(
      accountIds.map((id, index) => {
        return {
          ...owner,
          id,
          modelProviderId: providerId,
          authMethod,
          isActive: id === sourceId,
          externalAccountId: `synthetic-account-${index}`,
        };
      }),
    );
    await tx.insert(modelProviderAccountSecrets).values(
      accountIds.flatMap((id, index) => {
        return cells.map(({ name, encryptedValue }) => {
          return {
            modelProviderAccountId: id,
            name,
            encryptedValue:
              id === sourceId
                ? encryptedValue
                : `synthetic-inactive-cell:${index}:${name}`,
          };
        });
      }),
    );
  });
  return {
    providerId,
    args: { ...owner, sourceId, db: database, featureSwitchContext: {} },
    async close() {
      await database.transaction(async (tx) => {
        await tx
          .delete(modelProviders)
          .where(
            and(
              eq(modelProviders.id, providerId),
              eq(modelProviders.orgId, owner.orgId),
              eq(modelProviders.userId, owner.userId),
            ),
          );
        await tx
          .delete(secrets)
          .where(
            and(
              eq(secrets.orgId, owner.orgId),
              eq(secrets.userId, owner.userId),
              eq(secrets.type, "model-provider"),
            ),
          );
      });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function operation(
  fixture: Fixture,
  stage: Stage,
  sample: Sample,
  prepared: PreparedPersonalSubscriptionAdmission,
  signal: AbortSignal,
) {
  const args = fixture.args;
  if (stage === "prepare-fresh-proof") {
    return await preparePersonalSubscriptionAdmission(
      { ...args, timing: new SampleTiming(sample) },
      signal,
    );
  }
  if (stage === "validate-final-locked") {
    return await args.db.transaction(async (tx) => {
      return await validatePersonalSubscriptionAdmission(
        { ...args, db: tx },
        prepared,
      );
    });
  }
  if (stage === "environment-database-fragment") {
    // Same database calls as the private exact environment resolver; excludes
    // its subsequent in-memory environment/firewall construction.
    const account = await personalModelProviderAccountById({
      ...args,
      id: args.sourceId,
    });
    return account
      ? await readCoordinatedPersonalSubscriptionAccount(args, signal)
      : null;
  }
  return await captureActivePersonalModelProviderAccount(
    {
      ...args,
      modelProviderId:
        stage === "capture-concrete"
          ? args.sourceId
          : stage === "capture-explicit-logical"
            ? fixture.providerId
            : null,
    },
    signal,
  );
}

function statistics(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => {
    return a - b;
  });
  return {
    min: sorted[0],
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    max: sorted.at(-1),
  };
}

function totalSqlMs(sample: Sample) {
  return sample.queries.reduce((sum, query) => {
    return sum + query.ms;
  }, 0);
}

function queryRole(statement: string) {
  if (statement.includes("pg_advisory_xact_lock")) {
    return "advisory";
  }
  if (statement.includes('"subscription_provider"')) {
    return "provider-account-inventory";
  }
  if (statement.includes('"model_provider_account_secrets"')) {
    return "account-secrets";
  }
  if (statement.includes('"model_provider_accounts"')) {
    return statement.includes("for no key update")
      ? "accounts-lock"
      : "account-lookup";
  }
  if (statement.includes('"model_providers"')) {
    return statement.includes("for no key update")
      ? "provider-lock"
      : "provider-lookup";
  }
  if (statement.includes('"secrets"')) {
    return "mirror-secrets";
  }
  return statement.trim().split(/\s+/)[0]?.toLowerCase() ?? "query";
}

function summarize(samples: readonly Sample[]) {
  const distribution = (get: (sample: Sample) => number) => {
    return statistics(samples.map(get));
  };
  return {
    samples: samples.length,
    totalMs: distribution((sample) => {
      return sample.totalMs;
    }),
    totalSqlMs: distribution(totalSqlMs),
    // Subtract within each observation before calculating percentiles. This
    // remainder includes query construction/decoding and other client work;
    // it is not a direct CPU measurement or a subtraction of percentiles.
    outsideSqlSpansMs: distribution((sample) => {
      return sample.totalMs - totalSqlMs(sample);
    }),
    sqlByRoleMs: Object.fromEntries(
      [
        ...new Set(
          samples[0]?.queries.map((query) => {
            return query.role;
          }),
        ),
      ].map((role) => {
        return [
          role,
          distribution((sample) => {
            return sample.queries
              .filter((query) => {
                return query.role === role;
              })
              .reduce((sum, query) => {
                return sum + query.ms;
              }, 0);
          }),
        ];
      }),
    ),
    sqlStatements: distribution((sample) => {
      return sample.queries.filter((query) => {
        return query.kind !== "begin" && query.kind !== "commit";
      }).length;
    }),
    transactionStatements: distribution((sample) => {
      return sample.queries.filter((query) => {
        return query.kind === "begin" || query.kind === "commit";
      }).length;
    }),
    sqlExcludingAdvisoryMs: distribution((sample) => {
      return sample.queries
        .filter((query) => {
          return !["advisory", "begin", "commit"].includes(query.kind);
        })
        .reduce((sum, query) => {
          return sum + query.ms;
        }, 0);
    }),
    advisoryWaitAndRoundTripMs: distribution((sample) => {
      return sample.queries
        .filter((query) => {
          return query.kind === "advisory";
        })
        .reduce((sum, query) => {
          return sum + query.ms;
        }, 0);
    }),
    lockHeldClientMs: distribution((sample) => {
      const acquired = sample.queries.find((query) => {
        return query.kind === "advisory";
      });
      const committed = sample.queries.find((query) => {
        return query.kind === "commit";
      });
      if (!acquired || !committed) {
        throw new Error("Missing measured lock/commit boundary");
      }
      return committed.end - acquired.end;
    }),
    timings: Object.fromEntries(
      Object.keys(samples[0]?.timings ?? {}).map((action) => {
        return [
          action,
          distribution((sample) => {
            const duration = sample.timings[action];
            if (duration === undefined) {
              throw new Error("Missing measured stage timing");
            }
            return duration;
          }),
        ];
      }),
    ),
    observations: samples.map((sample) => {
      const sqlMs = totalSqlMs(sample);
      return {
        totalMs: sample.totalMs,
        totalSqlMs: sqlMs,
        outsideSqlSpansMs: sample.totalMs - sqlMs,
      };
    }),
  };
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Subplan Name"?: string;
  "Sort Key"?: string[];
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

// Deliberately omit filters/index conditions/output expressions: PostgreSQL
// substitutes bound fixture values into those strings during EXPLAIN.
const planNodeSchema: z.ZodType<PlanNode> = z.lazy(() => {
  return z.object({
    "Node Type": z.string(),
    "Relation Name": z.string().optional(),
    "Index Name": z.string().optional(),
    "Subplan Name": z.string().optional(),
    "Sort Key": z.array(z.string()).optional(),
    "Actual Rows": z.number().optional(),
    "Actual Loops": z.number().optional(),
    "Shared Hit Blocks": z.number().optional(),
    "Shared Read Blocks": z.number().optional(),
    Plans: z.array(planNodeSchema).optional(),
  });
});

const explainSchema = z.array(
  z.object({
    "QUERY PLAN": z.array(
      z.object({
        Plan: planNodeSchema,
        "Planning Time": z.number(),
        "Execution Time": z.number(),
      }),
    ),
  }),
);

async function explainSnapshot(pool: Pool, statements: readonly Statement[]) {
  const client = await pool.connect();
  const plans: { query: string; plan: z.infer<typeof explainSchema> }[] = [];
  const work = async () => {
    await client.query("BEGIN");
    for (const statement of statements) {
      if (statement.query.includes("pg_advisory_xact_lock")) {
        await client.query(statement.query, statement.parameters);
      } else if (/^(select|with)\b/i.test(statement.query.trim())) {
        const result = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`,
          statement.parameters,
        );
        plans.push({
          query: statement.query,
          plan: explainSchema.parse(result.rows),
        });
      }
    }
    return plans;
  };
  const result = await settleIncludingAbort(work());
  const rollback = await settleIncludingAbort(client.query("ROLLBACK"));
  client.release();
  if (!rollback.ok) {
    throw rollback.error;
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function digest(url: URL) {
  return createHash("sha256")
    .update(await readFile(url))
    .digest("hex");
}

async function reportEnvironment(pool: Pool) {
  const version = z
    .array(z.object({ server_version: z.string() }))
    .parse((await pool.query("SHOW server_version")).rows);
  process.stdout.write(
    JSON.stringify({
      environment: {
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        sourceDirty:
          execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf8",
          }).trim().length > 0,
        implementationSha256: await digest(
          new URL(
            "../signals/services/model-provider-account.service.ts",
            import.meta.url,
          ),
        ),
        harnessSha256: await digest(new URL(import.meta.url)),
        lockfileSha256: await digest(
          new URL("../../../../pnpm-lock.yaml", import.meta.url),
        ),
        node: process.version,
        postgres: version[0]?.server_version,
        poolMax: 2,
        warmups,
        repetitions,
        inventorySize,
        fixture:
          "one active connected account, optional nine inactive; identical active canonical/mirror cells; Claude 1 field, Codex 4 fields per account",
        limits:
          "Sequential local service fragments including transaction completion; no artificial delay, KMS, HTTP, OAuth, admission lifecycle rows, queue insert or production latency claim",
      },
    }) + "\n",
  );
}

function collectQuerySpan(
  samples: AsyncLocalStorage<Sample>,
  span: ReadableSpan,
) {
  const sample = samples.getStore();
  const statement = span.attributes["db.statement"];
  if (!sample || typeof statement !== "string") {
    return;
  }
  sample.queries.push({
    role: queryRole(statement),
    kind: statement.includes("pg_advisory_xact_lock")
      ? "advisory"
      : (statement.trim().split(/\s+/)[0]?.toLowerCase() ?? "query"),
    ms: span.duration[0] * 1000 + span.duration[1] / 1e6,
    end: span.endTime[0] * 1000 + span.endTime[1] / 1e6,
  });
}

async function runExperiment() {
  const url = new URL(env("DATABASE_URL"));
  if (
    env("ENV") !== "development" ||
    !["localhost", "127.0.0.1", "postgres"].includes(url.hostname)
  ) {
    throw new Error(
      "The coordination experiment requires local development PostgreSQL",
    );
  }
  const signal = AbortSignal.timeout(120_000);
  const samples = new AsyncLocalStorage<Sample>();
  const tracer = new BasicTracerProvider({
    spanProcessors: [
      {
        onStart() {},
        onEnd(span: ReadableSpan) {
          collectQuerySpan(samples, span);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  const pool = instrumentPgPool(
    new Pool({
      connectionString: url.toString(),
      max: 2,
      statement_timeout: 10_000,
      connectionTimeoutMillis: 10_000,
    }),
    tracer.getTracer("subscription-coordination-experiment"),
  );
  const database = drizzle(pool, {
    logger: {
      logQuery(query, parameters) {
        samples.getStore()?.statements.push({ query, parameters });
      },
    },
  });
  const work = async () => {
    await reportEnvironment(pool);
    for (const type of [
      "claude-code-oauth-token",
      "codex-oauth-token",
    ] as const) {
      const fixture = await seed(database, type);
      const measureFixture = async () => {
        const prepared = await preparePersonalSubscriptionAdmission(
          { ...fixture.args, timing: new ApiDispatchTimingCollector() },
          signal,
        );
        if (!prepared) {
          throw new Error("Synthetic coherent snapshot could not prepare");
        }
        for (const stage of stages) {
          const observations: Sample[] = [];
          const cpuStarted = process.cpuUsage();
          for (let index = 0; index < warmups + repetitions; index++) {
            signal.throwIfAborted();
            const sample: Sample = {
              totalMs: 0,
              queries: [],
              statements: [],
              timings: {},
            };
            const started = performance.now();
            const result = await samples.run(sample, async () => {
              return await operation(fixture, stage, sample, prepared, signal);
            });
            sample.totalMs = performance.now() - started;
            if (!result) {
              throw new Error("Synthetic coherent service operation failed");
            }
            if (index >= warmups) {
              observations.push(sample);
            }
          }
          const cpuUsage = process.cpuUsage(cpuStarted);
          process.stdout.write(
            JSON.stringify({
              type,
              stage,
              inventorySize,
              cpuMsPerOperation: {
                user: cpuUsage.user / 1000 / (warmups + repetitions),
                system: cpuUsage.system / 1000 / (warmups + repetitions),
              },
              ...summarize(observations),
            }) + "\n",
          );
          const first = observations[0];
          if (stage === "prepare-fresh-proof" && first) {
            process.stdout.write(
              JSON.stringify({
                type,
                inventorySize,
                snapshotStatementOrder: first.statements.map((statement) => {
                  return statement.query;
                }),
                snapshotPlans: await explainSnapshot(pool, first.statements),
              }) + "\n",
            );
          }
        }
      };
      const result = await settleIncludingAbort(measureFixture());
      await fixture.close();
      if (!result.ok) {
        throw result.error;
      }
    }
  };
  const result = await settleIncludingAbort(work());
  const poolClosed = await settleIncludingAbort(pool.end());
  await tracer.shutdown();
  if (!poolClosed.ok) {
    throw poolClosed.error;
  }
  if (!result.ok) {
    throw result.error;
  }
}

await runExperiment();

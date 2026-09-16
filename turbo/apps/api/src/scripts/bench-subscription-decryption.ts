/** Controlled local experiment, not an API correctness test or production benchmark.
 * Synthetic database rows are necessary to repeat identical locked snapshots and
 * historical independently re-encrypted cells. Route tests own product assertions.
 * No credentials or SQL parameters are printed. Only UUID-owned rows are removed. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { delay } from "signal-timers";
import { execFileSync } from "node:child_process";
import {
  BasicTracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";
import { env } from "../lib/env";
import { nowDate } from "../lib/time";
import { joinAll, settleIncludingAbort } from "../signals/utils";
import type { Db } from "../signals/external/db";
import { instrumentPgPool } from "../lib/db-instrumentation";
import {
  withSecretKmsClientForTest,
  type SecretKmsClient,
} from "../lib/secret-kms-client";
import { encryptStoredSecretValue } from "../signals/services/crypto.utils";
import {
  readPersonalSubscriptionCredentialBundle,
  type PersonalSubscriptionProviderType,
} from "../signals/services/model-provider-account.service";

interface Sample {
  calls: number;
  active: number;
  peak: number;
  kmsMs: number;
  totalMs: number;
  failed: boolean;
  queries: { kind: string; ms: number; end: number }[];
}

interface WorkloadState {
  workloadActive: number;
  workloadPeak: number;
  dependencyDelay: number;
  failFirst: boolean;
}

async function seed(database: Db, type: PersonalSubscriptionProviderType) {
  const owner = {
    orgId: `decrypt-bench-${randomUUID()}`,
    userId: randomUUID(),
    type,
  };
  const providerId = randomUUID();
  const sourceId = randomUUID();
  const rowPrefix = randomUUID().slice(0, 24);
  const values =
    type === "claude-code-oauth-token"
      ? { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-claude" }
      : {
          CHATGPT_ACCESS_TOKEN: "synthetic-access",
          CHATGPT_REFRESH_TOKEN: "synthetic-refresh",
          CHATGPT_ACCOUNT_ID: "synthetic-account",
          CHATGPT_ID_TOKEN: "synthetic-id",
        };
  const rows = await Promise.all(
    Object.entries(values).map(async ([name, value], index) => {
      // Keep comparison short-circuit position identical across baseline/candidate.
      return {
        id: `${rowPrefix}${String(index + 1).padStart(12, "0")}`,
        name,
        encryptedValue: await encryptStoredSecretValue(value),
      };
    }),
  );
  await database.transaction(async (tx) => {
    await tx.insert(secrets).values(
      rows.map((row) => {
        return { ...row, ...owner, type: "model-provider" };
      }),
    );
    await tx.insert(modelProviders).values({
      ...owner,
      id: providerId,
      secretId: type === "claude-code-oauth-token" ? rows[0]?.id : null,
      authMethod: "auth_json",
    });
    await tx.insert(modelProviderAccounts).values({
      ...owner,
      id: sourceId,
      modelProviderId: providerId,
      authMethod: "auth_json",
      isActive: true,
      externalAccountId: "synthetic-account",
    });
    await tx.insert(modelProviderAccountSecrets).values(
      rows.map(({ name, encryptedValue }) => {
        return { modelProviderAccountId: sourceId, name, encryptedValue };
      }),
    );
  });
  return {
    args: { ...owner, sourceId, db: database, featureSwitchContext: {} },
    async mirror(mode: "equivalent" | "replacement" | "expiry") {
      if (mode === "expiry") {
        await database
          .update(modelProviders)
          .set({
            tokenExpiresAt: nowDate(),
            needsReconnect: true,
            lastRefreshErrorCode: "invalid_grant",
          })
          .where(eq(modelProviders.id, providerId));
        return;
      }
      for (const [name, value] of Object.entries(values)) {
        const row = rows.find((item) => {
          return item.name === name;
        });
        if (!row) {
          throw new Error("Missing synthetic row");
        }
        const plaintext =
          mode === "replacement" && name === "CHATGPT_ACCESS_TOKEN"
            ? randomUUID()
            : value;
        await database
          .update(secrets)
          .set({ encryptedValue: await encryptStoredSecretValue(plaintext) })
          .where(eq(secrets.id, row.id));
      }
    },
    async close() {
      await database
        .delete(modelProviders)
        .where(eq(modelProviders.id, providerId));
      await database.delete(secrets).where(eq(secrets.orgId, owner.orgId));
    },
  };
}

async function measure(
  samples: AsyncLocalStorage<Sample>,
  expectedFailure: boolean,
  args: Parameters<typeof readPersonalSubscriptionCredentialBundle>[0],
): Promise<Sample> {
  const sample: Sample = {
    calls: 0,
    active: 0,
    peak: 0,
    kmsMs: 0,
    totalMs: 0,
    failed: false,
    queries: [],
  };
  const start = performance.now();
  await samples.run(sample, async () => {
    const result = await settleIncludingAbort(
      readPersonalSubscriptionCredentialBundle(args),
    );
    if (result.ok) {
      if (!result.value) {
        throw new Error("Missing synthetic bundle");
      }
    } else {
      const error = result.error;
      if (
        !(error instanceof Error) ||
        error.message !== "Synthetic KMS failure"
      ) {
        throw error;
      }
      sample.failed = true;
    }
  });
  sample.totalMs = performance.now() - start;
  if (sample.active !== 0 || sample.failed !== expectedFailure) {
    throw new Error(
      "Operation ended with unexpected outcome or unjoined decrypts",
    );
  }
  return sample;
}

function summary(observations: readonly Sample[]) {
  const numbers = (get: (sample: Sample) => number) => {
    const sorted = observations.map(get).sort((a, b) => {
      return a - b;
    });
    return {
      min: sorted[0],
      p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
      max: sorted.at(-1),
    };
  };
  return {
    samples: observations.length,
    failures: observations.filter((sample) => {
      return sample.failed;
    }).length,
    logicalKmsCalls: numbers((sample) => {
      return sample.calls;
    }),
    logicalKmsPeak: numbers((sample) => {
      return sample.peak;
    }),
    kmsSumMs: numbers((sample) => {
      return sample.kmsMs;
    }),
    totalMs: numbers((sample) => {
      return sample.totalMs;
    }),
    queryCount: numbers((sample) => {
      return sample.queries.length;
    }),
    sqlExcludingAdvisoryMs: numbers((sample) => {
      return sample.queries
        .filter((query) => {
          return query.kind !== "lock";
        })
        .reduce((sum, query) => {
          return sum + query.ms;
        }, 0);
    }),
    advisoryWaitRoundTripMs: numbers((sample) => {
      return sample.queries
        .filter((query) => {
          return query.kind === "lock";
        })
        .reduce((sum, query) => {
          return sum + query.ms;
        }, 0);
    }),
    lockHeldClientMs: numbers((sample) => {
      const acquired = sample.queries.find((query) => {
        return query.kind === "lock";
      });
      const end = [...sample.queries].reverse().find((query) => {
        return query.kind === "commit" || query.kind === "rollback";
      });
      if (!acquired || !end) {
        throw new Error("Missing transaction measurement");
      }
      return end.end - acquired.end;
    }),
  };
}

async function reportEnvironment(pool: Pool) {
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
        node: process.version,
        implementationSha256: createHash("sha256")
          .update(
            await readFile(
              new URL(
                "../signals/services/model-provider-account.service.ts",
                import.meta.url,
              ),
            ),
          )
          .digest("hex"),
        harnessSha256: createHash("sha256")
          .update(await readFile(new URL(import.meta.url)))
          .digest("hex"),
        postgres: (await pool.query("SHOW server_version")).rows,
        poolMax: 8,
        repetitions: 5,
        limits:
          "Synthetic KMS; local instrumented bundle service including transaction completion, not HTTP, OAuth refresh or api_to_spawn",
      },
    }) + "\n",
  );
}

async function measureWorkloads(
  database: Db,
  pool: Pool,
  samples: AsyncLocalStorage<Sample>,
  state: WorkloadState,
) {
  const fixtures: Awaited<ReturnType<typeof seed>>[] = [];
  const work = async () => {
    const claude = await seed(database, "claude-code-oauth-token");
    fixtures.push(claude);
    for (let index = 0; index < 4; index++) {
      fixtures.push(await seed(database, "codex-oauth-token"));
    }
    const codex = fixtures[1];
    if (!codex) {
      throw new Error("Missing Codex fixture");
    }
    await reportEnvironment(pool);
    for (const mode of [
      "claude",
      "codex",
      "same-provider-4",
      "different-providers-4",
      "equivalent",
      "replacement",
      "expiry",
      "failure-slow-sibling",
    ] as const) {
      state.dependencyDelay = 20;
      state.failFirst = mode === "failure-slow-sibling";
      state.workloadPeak = 0;
      const observations: Sample[] = [];
      for (let repeat = 0; repeat < 6; repeat++) {
        if (
          mode === "equivalent" ||
          mode === "replacement" ||
          mode === "expiry"
        ) {
          await codex.mirror(mode);
        }
        const owners =
          mode === "claude"
            ? [claude]
            : mode === "same-provider-4"
              ? Array.from({ length: 4 }, () => {
                  return codex;
                })
              : mode === "different-providers-4"
                ? fixtures.slice(1)
                : [codex];
        const results = await Promise.allSettled(
          owners.map((owner) => {
            return measure(samples, state.failFirst, owner.args);
          }),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
          if (repeat > 0) {
            observations.push(result.value);
          }
        }
        if (state.workloadActive !== 0) {
          throw new Error("Unjoined workload");
        }
      }
      process.stdout.write(
        JSON.stringify({
          mode,
          simulatedKmsDelayMs: state.dependencyDelay,
          simulatedSlowSiblingMs: state.failFirst ? 80 : null,
          workloadPeak: state.workloadPeak,
          ...summary(observations),
        }) + "\n",
      );
    }
  };
  const result = await settleIncludingAbort(work());
  await joinAll(
    fixtures.map((fixture) => {
      return fixture.close();
    }),
  );
  if (!result.ok) {
    throw result.error;
  }
}

async function runExperiment() {
  const samples = new AsyncLocalStorage<Sample>();
  const signal = AbortSignal.timeout(60_000);
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const url = new URL(env("DATABASE_URL"));
  if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname)) {
    throw new Error("The decryption experiment requires local PostgreSQL");
  }
  const state: WorkloadState = {
    workloadActive: 0,
    workloadPeak: 0,
    dependencyDelay: 0,
    failFirst: false,
  };
  const kms: SecretKmsClient = {
    generateDataKey(request) {
      return Promise.resolve({
        keyId: request.keyId,
        plaintext: key,
        encryptedDataKey: key,
      });
    },
    async decrypt() {
      const sample = samples.getStore();
      if (!sample) {
        return key;
      }
      const call = ++sample.calls;
      sample.active++;
      sample.peak = Math.max(sample.peak, sample.active);
      state.workloadPeak = Math.max(state.workloadPeak, ++state.workloadActive);
      const started = performance.now();
      const work = async () => {
        // Simulated logical-call service time, including a slow retrying sibling.
        await delay(
          state.failFirst && call === 2 ? 80 : state.dependencyDelay,
          { signal },
        );
        if (state.failFirst && call === 1) {
          throw new Error("Synthetic KMS failure");
        }
        return key;
      };
      return await work().finally(() => {
        sample.kmsMs += performance.now() - started;
        sample.active--;
        state.workloadActive--;
      });
    },
  };

  function collect(span: ReadableSpan) {
    const sample = samples.getStore();
    const statement = span.attributes["db.statement"];
    if (!sample || typeof statement !== "string") {
      return;
    }
    sample.queries.push({
      kind: statement.includes("pg_advisory_xact_lock")
        ? "lock"
        : (statement.trim().split(/\s+/)[0]?.toLowerCase() ?? "query"),
      ms: span.duration[0] * 1000 + span.duration[1] / 1e6,
      end: span.endTime[0] * 1000 + span.endTime[1] / 1e6,
    });
  }

  const tracer = new BasicTracerProvider({
    spanProcessors: [
      {
        onStart() {},
        onEnd: collect,
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  const pool = instrumentPgPool(
    new Pool({ connectionString: url.toString(), max: 8 }),
    tracer.getTracer("subscription-experiment"),
  );
  const database = drizzle(pool);

  const result = await settleIncludingAbort(
    withSecretKmsClientForTest(kms, async () => {
      await measureWorkloads(database, pool, samples, state);
    }),
  );
  await pool.end();
  await tracer.shutdown();
  if (!result.ok) {
    throw result.error;
  }
}

await runExperiment();

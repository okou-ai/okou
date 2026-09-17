import { randomUUID } from "node:crypto";
import { installPreparedDomainLegacyFunctions } from "../../../test-fixtures/prepared-domain-legacy-functions";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/schema/hosted-site";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import type { ApiDb, Tx } from "../../../lib/db-types";
import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../../lib/db-structured-result";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createDeferredPromise, settle } from "../../utils";
import { createHostedSiteDeployment } from "../host.service";
import {
  assertHostedDeploymentScope,
  canonicalizeHostedSiteScope,
  lockHostedRunChatThreadId,
} from "../hosted-site-scope.service";

const context = testContext();

// Product routes cannot select trigger presence, corrupt ownership, row-lock
// interleavings or an insertion failure after allocation. Exercise the actual
// allocation transaction in private schemas; route suites cover HTTP behavior.
async function createHarness(retainTriggers: boolean) {
  const schemaName = `host_scope_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 1,
    allowExitOnIdle: true,
  });
  const admin = drizzle(adminPool);
  const pool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 4,
    allowExitOnIdle: true,
    options: `-c search_path=${schemaName},public -c statement_timeout=10000`,
  });
  const db = drizzle(pool);
  const destroy = async () => {
    const closed = await settle(pool.end());
    const dropped = await settle(
      admin.execute(
        sql`DROP SCHEMA IF EXISTS ${sql.identifier(schemaName)} CASCADE`,
      ),
    );
    const adminClosed = await settle(adminPool.end());
    for (const result of [closed, dropped, adminClosed]) {
      if (!result.ok) {
        throw result.error;
      }
    }
  };
  const initialized = await settle(
    (async () => {
      const setupClient = await pool.connect();
      const created = await settle(
        drizzle(setupClient).transaction(async (tx) => {
          await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schemaName)}`);
          await tx.execute(sql`
      CREATE TABLE agent_runs (
        id uuid PRIMARY KEY, chat_thread_id uuid, trigger_source text
      )
    `);
          await tx.execute(
            sql`CREATE TABLE hosted_sites (LIKE public.hosted_sites INCLUDING ALL)`,
          );
          await tx.execute(
            sql`CREATE TABLE hosted_deployments (LIKE public.hosted_deployments INCLUDING ALL)`,
          );
          await tx.execute(
            sql`CREATE TABLE private_hosted_deployments (LIKE public.private_hosted_deployments INCLUDING ALL)`,
          );
          await tx.execute(sql`
      ALTER TABLE hosted_deployments ADD FOREIGN KEY (site_id, public_brand)
      REFERENCES hosted_sites (id, public_brand) ON DELETE CASCADE
    `);
          await tx.execute(sql`
      ALTER TABLE private_hosted_deployments ADD FOREIGN KEY (site_id, public_brand)
      REFERENCES hosted_sites (id, public_brand) ON DELETE CASCADE
    `);
          if (retainTriggers) {
            await installPreparedDomainLegacyFunctions(setupClient, [
              "canonicalize_hosted_site_scope_0753",
              "enforce_hosted_deployment_scope_0753",
            ]);
            await tx.execute(sql`
        CREATE TRIGGER canonicalize_hosted_site_scope_0753
        BEFORE INSERT OR UPDATE OF created_from_run_id, requested_slug, chat_thread_id
        ON hosted_sites FOR EACH ROW
        EXECUTE FUNCTION canonicalize_hosted_site_scope_0753()
      `);
            await tx.execute(sql`
        CREATE TRIGGER enforce_hosted_deployment_scope_0753
        BEFORE INSERT ON hosted_deployments FOR EACH ROW
        EXECUTE FUNCTION enforce_hosted_deployment_scope_0753()
      `);
          }
        }),
      );
      setupClient.release();
      if (!created.ok) {
        throw created.error;
      }
    })(),
  );
  if (!initialized.ok) {
    await destroy();
    throw initialized.error;
  }
  return { db, destroy };
}

function deploymentArgs(runId?: string, orgId = `org_${randomUUID()}`) {
  return {
    orgId,
    userId: `user_${randomUUID()}`,
    runId,
    publicBrand: "okou" as const,
    privateArtifacts: false,
    body: {
      site: `scope-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [
        {
          path: "/index.html",
          size: 10,
          sha256: "a".repeat(64),
          contentType: "text/html",
          immutable: false,
        },
      ],
    },
  };
}

async function seedRun(
  db: ApiDb,
  chatThreadId: string | null,
  triggerSource: string | null = "chat",
) {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO agent_runs (id, chat_thread_id, trigger_source)
    VALUES (${id}, ${chatThreadId}, ${triggerSource})
  `);
  return id;
}

function createDeployment(db: ApiDb, args: ReturnType<typeof deploymentArgs>) {
  return createHostedSiteDeployment(db, args, {
    now: nowDate(),
    deploymentId: randomUUID(),
    privateReference: args.privateArtifacts ? "scope12345" : null,
  });
}

async function requireDeployment(
  db: ApiDb,
  args: ReturnType<typeof deploymentArgs>,
) {
  const result = await createDeployment(db, args);
  if (result.kind !== "ok") {
    throw new Error(`Expected deployment, received ${result.kind}`);
  }
  return result;
}

async function backendPid(tx: Tx) {
  const [row] = await tx
    .select({
      pid: sql`pg_backend_pid()`.mapWith(pgIntegerDecoder),
    })
    .from(sql`(SELECT 1) AS backend`);
  if (!row) {
    throw new Error("Expected transaction backend");
  }
  return row.pid;
}

async function expectBlocked(db: ApiDb, pid: number) {
  await expect
    .poll(async () => {
      const [row] = await db
        .select({
          blocked: sql`cardinality(pg_blocking_pids(${pid})) > 0`.mapWith(
            pgBooleanDecoder,
          ),
        })
        .from(sql`(SELECT 1) AS blocking_state`);
      return row?.blocked;
    })
    .toBe(true);
}

describe.each([true, false])(
  "hosted ownership with retained triggers: %s",
  (retained) => {
    let harness: Awaited<ReturnType<typeof createHarness>>;

    beforeEach(async () => {
      harness = await createHarness(retained);
    });

    afterEach(async () => {
      await harness.destroy();
    });

    it.each([
      "chat",
      "no-metadata",
      "no-chat",
      "missing",
      "runless",
      "noncanonical",
    ] as const)(
      "canonicalizes a %s originating run and preserves explicit slug/owner values",
      async (kind) => {
        const chatThreadId = randomUUID();
        const runId =
          kind === "runless"
            ? undefined
            : kind === "missing"
              ? randomUUID()
              : kind === "noncanonical"
                ? "historical-text-reference"
                : await seedRun(
                    harness.db,
                    kind === "no-chat" ? null : chatThreadId,
                    kind === "no-metadata" ? null : "chat",
                  );
        const expected = kind === "chat" ? chatThreadId : null;
        const args = deploymentArgs(runId);
        await harness.db.transaction(async (tx) => {
          const scope = await canonicalizeHostedSiteScope(tx, {
            orgId: args.orgId,
            slug: args.body.site,
            createdFromRunId: runId,
          });
          const [site] = await tx
            .insert(hostedSites)
            .values({
              orgId: args.orgId,
              userId: args.userId,
              slug: args.body.site,
              publicSlug: args.body.site,
              publicBrand: "okou",
              createdFromRunId: runId,
              ...scope,
            })
            .returning();
          expect(site).toMatchObject({
            requestedSlug: args.body.site,
            chatThreadId: expected,
          });
          await expect(
            canonicalizeHostedSiteScope(tx, {
              orgId: args.orgId,
              slug: "ignored",
              requestedSlug: "",
              chatThreadId,
              createdFromRunId: runId,
            }),
          ).resolves.toStrictEqual({ requestedSlug: "", chatThreadId });
        });
      },
    );

    it("preserves the legacy text equality for uppercase UUID references", async () => {
      const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await harness.db.execute(sql`
        INSERT INTO agent_runs (id, chat_thread_id, trigger_source)
        VALUES (${runId}, ${randomUUID()}, 'chat')
      `);
      await expect(
        harness.db.transaction(async (tx) => {
          return await lockHostedRunChatThreadId(tx, runId.toUpperCase());
        }),
      ).resolves.toBeNull();
    });

    it.each(["clear", "move", "preserve"] as const)(
      "handles %s of established ownership before deriving a run owner",
      async (action) => {
        const owner = randomUUID();
        const runId = await seedRun(harness.db, owner);
        const original = await requireDeployment(
          harness.db,
          deploymentArgs(runId),
        );
        const chatThreadId =
          action === "clear" ? null : action === "move" ? randomUUID() : owner;
        const update = harness.db.transaction(async (tx) => {
          const scope = await canonicalizeHostedSiteScope(
            tx,
            {
              ...original.site,
              chatThreadId,
              requestedSlug: null,
            },
            original.site.id,
          );
          return await tx
            .update(hostedSites)
            .set(scope)
            .where(eq(hostedSites.id, original.site.id))
            .returning();
        });
        if (action === "preserve") {
          await expect(update).resolves.toMatchObject([
            { chatThreadId: owner, requestedSlug: original.site.slug },
          ]);
        } else {
          await expect(update).rejects.toThrow(
            "Hosted site chat ownership is immutable",
          );
          await expect(
            harness.db.select().from(hostedSites),
          ).resolves.toMatchObject([original.site]);
        }
      },
    );

    it("supports an explicit repair of a previously null owner without moving an established owner", async () => {
      const created = await requireDeployment(harness.db, deploymentArgs());
      const owner = randomUUID();
      const runId = await seedRun(harness.db, owner);
      await harness.db.transaction(async (tx) => {
        const values = { ...created.site, createdFromRunId: runId };
        const scope = await canonicalizeHostedSiteScope(
          tx,
          values,
          created.site.id,
        );
        await tx
          .update(hostedSites)
          .set({ ...scope, createdFromRunId: runId })
          .where(eq(hostedSites.id, created.site.id));
      });
      await expect(
        harness.db.select().from(hostedSites),
      ).resolves.toMatchObject([{ chatThreadId: owner }]);
      await expect(
        harness.db.transaction(async (tx) => {
          return await canonicalizeHostedSiteScope(
            tx,
            { ...created.site, orgId: "other-org" },
            created.site.id,
          );
        }),
      ).rejects.toThrow("Hosted site not found for scope update");
    });

    it.each([
      "same",
      "different",
      "runless",
      "no-metadata",
      "missing",
    ] as const)(
      "checks a %s deployment run against both null and non-null site ownership",
      async (kind) => {
        for (const owningChat of [null, randomUUID()]) {
          const ownerRun = await seedRun(harness.db, owningChat);
          const created = await requireDeployment(
            harness.db,
            deploymentArgs(ownerRun),
          );
          const runId =
            kind === "same"
              ? ownerRun
              : kind === "runless"
                ? undefined
                : kind === "missing"
                  ? randomUUID()
                  : await seedRun(
                      harness.db,
                      randomUUID(),
                      kind === "no-metadata" ? null : "chat",
                    );
          const allowed =
            kind === "same" || (owningChat === null && kind !== "different");
          const insertion = harness.db.transaction(async (tx) => {
            await assertHostedDeploymentScope(tx, {
              siteId: created.site.id,
              orgId: created.site.orgId,
              runId,
            });
            await tx.insert(hostedDeployments).values({
              ...created.deployment,
              id: randomUUID(),
              runId: runId ?? null,
              deploymentVersion: 2,
            });
          });
          if (allowed) {
            await insertion;
          } else {
            await expect(insertion).rejects.toThrow(
              "Hosted site belongs to a different chat",
            );
          }
        }
      },
    );

    it("retains outgoing trigger enforcement only while that schema supports old writers", async () => {
      const firstRun = await seedRun(harness.db, randomUUID());
      const otherRun = await seedRun(harness.db, randomUUID());
      const created = await requireDeployment(
        harness.db,
        deploymentArgs(firstRun),
      );
      const oldWrite = harness.db.insert(hostedDeployments).values({
        ...created.deployment,
        id: randomUUID(),
        deploymentVersion: 2,
        runId: otherRun,
      });
      if (retained) {
        await expect(oldWrite).rejects.toMatchObject({
          cause: { code: "23514" },
        });
      } else {
        await oldWrite;
      }
    });

    it("retains previous-API site canonicalization only on the supported old-writer schema", async () => {
      const owner = randomUUID();
      const runId = await seedRun(harness.db, owner);
      const args = deploymentArgs(runId);
      const [site] = await harness.db
        .insert(hostedSites)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          slug: args.body.site,
          publicSlug: args.body.site,
          publicBrand: "okou",
          createdFromRunId: runId,
        })
        .returning();
      expect(site).toMatchObject({
        requestedSlug: retained ? args.body.site : null,
        chatThreadId: retained ? owner : null,
      });
    });

    it("rejects deployment admission through another organization", async () => {
      const created = await requireDeployment(harness.db, deploymentArgs());
      await expect(
        harness.db.transaction(async (tx) => {
          await assertHostedDeploymentScope(tx, {
            siteId: created.site.id,
            orgId: `org_${randomUUID()}`,
          });
        }),
      ).rejects.toThrow("Hosted site not found for deployment");
    });

    it("reuses the same chat across runs, isolates other chats, and refuses organization-site adoption", async () => {
      const owner = randomUUID();
      const firstRun = await seedRun(harness.db, owner);
      const sameChatRun = await seedRun(harness.db, owner);
      const otherRun = await seedRun(harness.db, randomUUID());
      const args = deploymentArgs(firstRun);
      const first = await requireDeployment(harness.db, args);
      const second = await requireDeployment(harness.db, {
        ...args,
        runId: sameChatRun,
      });
      const other = await requireDeployment(harness.db, {
        ...args,
        runId: otherRun,
      });
      expect(second.site.id).toBe(first.site.id);
      expect(second.deployment.deploymentVersion).toBe(2);
      expect(other.site.id).not.toBe(first.site.id);
      expect(other.site.publicSlug).not.toBe(first.site.publicSlug);
      const unscoped = deploymentArgs();
      await requireDeployment(harness.db, unscoped);
      await expect(
        createDeployment(harness.db, { ...unscoped, runId: firstRun }),
      ).resolves.toMatchObject({ kind: "scope_conflict" });
    });

    it.each([false, true])(
      "serializes concurrent allocations and retains private owner checks (private=%s)",
      async (privateArtifacts) => {
        const runId = await seedRun(harness.db, randomUUID());
        const args = { ...deploymentArgs(runId), privateArtifacts };
        const created = await Promise.all(
          Array.from({ length: 3 }, async () => {
            return await requireDeployment(harness.db, args);
          }),
        );
        expect(
          new Set(
            created.map(({ site }) => {
              return site.id;
            }),
          ).size,
        ).toBe(1);
        expect(
          created
            .map(({ deployment }) => {
              return deployment.deploymentVersion;
            })
            .sort(),
        ).toStrictEqual([1, 2, 3]);
        const otherUser = await createDeployment(harness.db, {
          ...args,
          userId: `user_${randomUUID()}`,
        });
        expect(otherUser.kind).toBe(privateArtifacts ? "slug_conflict" : "ok");
      },
    );

    it.each([false, true])(
      "rolls back new sites and allocated versions after deployment insertion fails (private=%s)",
      async (privateArtifacts) => {
        const args = { ...deploymentArgs(), privateArtifacts };
        if (privateArtifacts) {
          await harness.db.execute(
            sql`ALTER TABLE private_hosted_deployments ADD CHECK (file_count < 2)`,
          );
        } else {
          await harness.db.execute(
            sql`ALTER TABLE hosted_deployments ADD CHECK (file_count < 2)`,
          );
        }
        const invalid = {
          ...args,
          body: {
            ...args.body,
            files: [
              ...args.body.files,
              { ...args.body.files[0]!, path: "/style.css" },
            ],
          },
        };
        await expect(
          createDeployment(harness.db, invalid),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
        await expect(
          harness.db.select().from(hostedSites),
        ).resolves.toStrictEqual([]);
        await requireDeployment(harness.db, args);
        await expect(
          createDeployment(harness.db, invalid),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
        const retry = await requireDeployment(harness.db, args);
        expect(retry.deployment.deploymentVersion).toBe(2);
        const table = privateArtifacts
          ? privateHostedDeployments
          : hostedDeployments;
        await expect(harness.db.select().from(table)).resolves.toHaveLength(2);
      },
    );

    it("locks a metadata-less run before site allocation and reads the committed owner after waiting", async () => {
      const runId = await seedRun(harness.db, null, null);
      const owner = randomUUID();
      const ready = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const pidReady = createDeferredPromise<number>(context.signal);
      const writer = harness.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE agent_runs SET trigger_source = 'chat', chat_thread_id = ${owner} WHERE id = ${runId}`,
        );
        ready.resolve();
        await release.promise;
      });
      await Promise.race([ready.promise, writer]);
      const contender = harness.db.transaction(async (tx) => {
        pidReady.resolve(await backendPid(tx));
        return await createDeployment(tx, deploymentArgs(runId));
      });
      const completed = Promise.all([settle(writer), settle(contender)]);
      const verified = await settle(
        pidReady.promise.then(async (pid) => {
          await expectBlocked(harness.db, pid);
        }),
      );
      release.resolve();
      const [written, created] = await completed;
      if (!verified.ok) {
        throw verified.error;
      }
      if (!written.ok) {
        throw written.error;
      }
      if (!created.ok) {
        throw created.error;
      }
      expect(created.value).toMatchObject({
        kind: "ok",
        site: { chatThreadId: owner },
      });
    });

    it.each(["chat", null])(
      "holds run and site ownership until deployment admission commits (source=%s)",
      async (source) => {
        const owner = randomUUID();
        const runId = await seedRun(harness.db, owner, source);
        const created = await requireDeployment(
          harness.db,
          deploymentArgs(runId),
        );
        const ready = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        const guard = harness.db.transaction(async (tx) => {
          await assertHostedDeploymentScope(tx, {
            siteId: created.site.id,
            orgId: created.site.orgId,
            runId,
          });
          ready.resolve();
          await release.promise;
        });
        await Promise.race([ready.promise, guard]);
        const completed = settle(guard);
        const verified = await settle(
          (async () => {
            await expect(
              harness.db.transaction(async (tx) => {
                await tx
                  .select({ id: agentRuns.id })
                  .from(agentRuns)
                  .where(eq(agentRuns.id, runId))
                  .for("no key update", { noWait: true });
              }),
            ).rejects.toMatchObject({ cause: { code: "55P03" } });
            await expect(
              harness.db.transaction(async (tx) => {
                await tx
                  .select({ id: hostedSites.id })
                  .from(hostedSites)
                  .where(eq(hostedSites.id, created.site.id))
                  .for("no key update", { noWait: true });
              }),
            ).rejects.toMatchObject({ cause: { code: "55P03" } });
          })(),
        );
        release.resolve();
        const guarded = await completed;
        if (!verified.ok) {
          throw verified.error;
        }
        if (!guarded.ok) {
          throw guarded.error;
        }
      },
    );

    it("takes the run lock before waiting for an outgoing allocator's site lock", async () => {
      const runId = await seedRun(harness.db, randomUUID());
      const args = deploymentArgs(runId);
      const first = await requireDeployment(harness.db, args);
      const ready = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const pidReady = createDeferredPromise<number>(context.signal);
      const outgoing = harness.db.transaction(async (tx) => {
        await tx
          .select({ id: hostedSites.id })
          .from(hostedSites)
          .where(eq(hostedSites.id, first.site.id))
          .for("update");
        ready.resolve();
        await release.promise;
      });
      await Promise.race([ready.promise, outgoing]);
      const contender = harness.db.transaction(async (tx) => {
        pidReady.resolve(await backendPid(tx));
        return await createDeployment(tx, args);
      });
      const completion = Promise.all([settle(outgoing), settle(contender)]);
      const verified = await settle(
        pidReady.promise.then(async (pid) => {
          await expectBlocked(harness.db, pid);
          await expect(
            harness.db.transaction(async (tx) => {
              await tx
                .select({ id: agentRuns.id })
                .from(agentRuns)
                .where(eq(agentRuns.id, runId))
                .for("no key update", { noWait: true });
            }),
          ).rejects.toMatchObject({ cause: { code: "55P03" } });
        }),
      );
      release.resolve();
      const [released, created] = await completion;
      if (!verified.ok) {
        throw verified.error;
      }
      if (!released.ok) {
        throw released.error;
      }
      if (!created.ok) {
        throw created.error;
      }
      expect(created.value).toMatchObject({
        kind: "ok",
        deployment: { deploymentVersion: 2 },
      });
    });
  },
);

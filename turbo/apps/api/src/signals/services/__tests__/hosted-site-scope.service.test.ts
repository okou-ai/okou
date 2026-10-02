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
import type { ApiDb } from "../../../lib/db-types";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createDeferredPromise, settle } from "../../utils";
import { expectApiError } from "../../routes/__tests__/helpers/api-bdd";
import { hostedTextFile } from "../../routes/__tests__/helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "../../routes/__tests__/helpers/api-bdd-host-maps";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "../../routes/__tests__/helpers/chat-events-fixture";
import { createHostedSiteDeployment } from "../host.service";
import {
  assertHostedDeploymentScope,
  canonicalizeHostedSiteScope,
  lockHostedRunChatThreadId,
} from "../hosted-site-scope.service";

const context = testContext();
const fixture = createChatEventsFixture(context);
const host = createHostMapsBddApi(context);

// Product routes cannot select trigger presence, corrupt ownership, row-lock
// interleavings or an insertion failure after allocation. Exercise the actual
// allocation transaction in private schemas; route suites cover HTTP behavior,
// including the publication scope cases in the route-level describe below.
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
      ALTER TABLE hosted_deployments ADD FOREIGN KEY (site_id, link_layout_segment)
      REFERENCES hosted_sites (id, link_layout_segment) ON DELETE CASCADE
    `);
          await tx.execute(sql`
      ALTER TABLE private_hosted_deployments ADD FOREIGN KEY (site_id, link_layout_segment)
      REFERENCES hosted_sites (id, link_layout_segment) ON DELETE CASCADE
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
              linkLayoutSegment: "okou",
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
              manifest: {
                ...created.deployment.manifest,
                deploymentVersion: 2,
              },
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
        manifest: { ...created.deployment.manifest, deploymentVersion: 2 },
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
          linkLayoutSegment: "okou",
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

    it("rolls back a slug reservation after deployment insertion fails", async () => {
      const args = deploymentArgs();
      await harness.db.execute(
        sql`ALTER TABLE hosted_deployments ADD CHECK (file_count < 2)`,
      );
      const invalid = {
        ...args,
        body: {
          ...args.body,
          files: [
            ...args.body.files,
            { ...args.body.files[0]!, path: "/style-7f21b8e3.css" },
          ],
        },
      };
      await expect(createDeployment(harness.db, invalid)).rejects.toMatchObject(
        { cause: { code: "23514" } },
      );
      await expect(
        harness.db.select().from(hostedSites),
      ).resolves.toStrictEqual([]);
      await requireDeployment(harness.db, args);
      const nextBody = { ...args.body, site: `${args.body.site}-next` };
      await expect(
        createDeployment(harness.db, {
          ...invalid,
          body: { ...invalid.body, site: nextBody.site },
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
      const retry = await requireDeployment(harness.db, {
        ...args,
        body: nextBody,
      });
      expect(retry.site.publicSlug).toBe(nextBody.site);
      await expect(
        harness.db.select().from(hostedDeployments),
      ).resolves.toHaveLength(2);
      // Hosted publications are public, so the private table stays empty.
      await expect(
        harness.db.select().from(privateHostedDeployments),
      ).resolves.toStrictEqual([]);
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

    it("allocates a suffix while keeping a deleted site's slug reserved", async () => {
      const args = deploymentArgs();
      const created = await requireDeployment(harness.db, args);
      await harness.db
        .update(hostedSites)
        .set({ deletedAt: nowDate() })
        .where(eq(hostedSites.id, created.site.id));
      const replacement = await requireDeployment(harness.db, args);
      expect(replacement.site.id).not.toBe(created.site.id);
      expect(replacement.site.publicSlug).not.toBe(created.site.publicSlug);
      expect(replacement.site.publicSlug).toMatch(
        new RegExp(`^${args.body.site}-[a-z0-9]{4}$`, "u"),
      );
    });

    it("redeploys a historical requested name even when its public slug differs", async () => {
      const args = deploymentArgs();
      const legacy = await requireDeployment(harness.db, args);
      const legacySlug = `${args.body.site}-legacy`;
      await harness.db
        .update(hostedSites)
        .set({ slug: legacySlug, publicSlug: legacySlug })
        .where(eq(hostedSites.id, legacy.site.id));
      const replacement = await requireDeployment(harness.db, args);
      expect(replacement.site.id).toBe(legacy.site.id);
      expect(replacement.site.publicSlug).toBe(legacySlug);
      expect(replacement.site.requestedSlug).toBe(args.body.site);
      expect(replacement.deployment.manifest.deploymentVersion).toBe(2);
    });
  },
);

function hostedSiteBody(site: string, content: string) {
  return {
    site,
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${content}</main>`)],
  };
}

/** Launch and claim a chat run; its claimed Okou token publishes as the chat. */
async function claimedChatRun(
  entitled: Awaited<ReturnType<typeof fixture.entitledNativeChatActor>>,
  prompt: string,
  threadId?: string,
) {
  const run = await fixture.sendChatRun(entitled.actor, {
    agentId: entitled.agentId,
    prompt,
    ...(threadId === undefined ? {} : { threadId }),
  });
  const { claim, sandboxHeaders } = await fixture.claimChatRun(
    entitled.runnerGroup,
    run.runId,
  );
  return {
    ...run,
    sandboxHeaders,
    bearer: `Bearer ${okouTokenFromClaim(claim)}`,
  };
}

describe("hosted publication scope through host APIs", () => {
  it("redeploys one site per scope within and across chat and organization scopes", async () => {
    const entitled = await fixture.entitledNativeChatActor();
    host.captureHostedSitesS3();
    const site = `scope-${randomUUID().slice(0, 8)}`;

    const firstRun = await claimedChatRun(entitled, "publish the first site");
    const first = await fixture.chat.prepareHostedSiteWithBearer(
      firstRun.bearer,
      hostedSiteBody(site, "first"),
    );
    await fixture.completeChatRunOk(firstRun.runId, firstRun.sandboxHeaders);

    // The same preferred name in one chat redeploys its site; another chat
    // owns a separate site under a suffixed name.
    const sameChatRun = await claimedChatRun(
      entitled,
      "publish the site again",
      firstRun.threadId,
    );
    const second = await fixture.chat.prepareHostedSiteWithBearer(
      sameChatRun.bearer,
      hostedSiteBody(site, "second"),
    );
    const otherRun = await claimedChatRun(entitled, "publish in another chat");
    const other = await fixture.chat.prepareHostedSiteWithBearer(
      otherRun.bearer,
      hostedSiteBody(site, "other"),
    );
    expect(second.siteId).toBe(first.siteId);
    expect(second.deploymentVersion).toBe(2);
    expect(other.siteId).not.toBe(first.siteId);
    expect(other.publicSlug).not.toBe(first.publicSlug);

    // A chat cannot take over a name the organization already owns.
    const organizationSite = `scope-org-${randomUUID().slice(0, 8)}`;
    await host.prepareHostedSite(
      entitled.actor,
      hostedSiteBody(organizationSite, "organization"),
    );
    const takeover = await fixture.chat.requestPrepareHostedSiteWithBearer(
      sameChatRun.bearer,
      hostedSiteBody(organizationSite, "takeover"),
      [409],
    );
    expectApiError(takeover.body);
    expect(takeover.body.error.message).toBe(
      `Hosted site slug "${organizationSite}" is owned outside this chat. Choose a different --site value and rerun the same okou host command.`,
    );
  }, 120_000);

  it("serializes concurrent redeploys of one site and rejects other owners", async () => {
    const entitled = await fixture.entitledNativeChatActor();
    host.captureHostedSitesS3();
    const site = `scope-${randomUUID().slice(0, 8)}`;
    const run = await claimedChatRun(entitled, "publish concurrently");
    const created = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        return await fixture.chat.prepareHostedSiteWithBearer(
          run.bearer,
          hostedSiteBody(site, `concurrent ${index}`),
        );
      }),
    );
    expect(
      new Set(
        created.map((result) => {
          return result.siteId;
        }),
      ).size,
    ).toBe(1);
    // Each concurrent publication still owns a distinct version.
    expect(
      new Set(
        created.map((result) => {
          return result.deploymentVersion;
        }),
      ),
    ).toStrictEqual(new Set([1, 2, 3]));

    // Redeploying replaces what the site serves, so organization membership
    // does not authorize it.
    const organizationSite = `scope-owner-${randomUUID().slice(0, 8)}`;
    await host.prepareHostedSite(
      entitled.actor,
      hostedSiteBody(organizationSite, "owner"),
    );
    const member = fixture.bdd.user({ orgId: entitled.actor.orgId });
    const conflict = await host.requestPrepareHostedSite(
      member,
      hostedSiteBody(organizationSite, "member"),
      [409],
    );
    expectApiError(conflict.body);
    expect(conflict.body.error.message).toBe(
      `Hosted site "${organizationSite}" belongs to another owner. Choose a different --site value and rerun the same okou host command.`,
    );
  }, 120_000);
});

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  claimErasureWork,
  executeErasureWork,
  finalizeErasureJob,
  projectErasureDecision,
  reviseErasureInventory,
  sealErasureCapture,
  type ErasureSink,
} from "@okouai/db/operations/account-erasure";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import {
  HOSTED_SITE_ERASURE_COLLECTOR_VERSION,
  createHostedSiteErasureCollector,
  hostedSiteErasurePrefixPage,
} from "../account-erasure-hosted-site-collector";
import { encryptErasureSelector } from "../account-erasure-selector";

// Explicit external-behavior exception, matching the dormant B1 persistence
// and relational-sweep suites. The erasure executor has no production caller
// until activation, so it is driven here the way the future worker will drive
// it. Object storage is mocked at its own boundary — the AWS SDK client the
// application really sends commands to — which is where the contract under
// test lives: what this sink asks the provider to delete, and what it accepts
// as proof the bytes are gone.
describe("dormant hosted-site object erasure", () => {
  const applicationName = `erasure_hosted_${randomUUID()}`;
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.searchParams.set("application_name", applicationName);
  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    application_name: applicationName,
    max: 8,
  });
  const db = drizzle(pool);
  const context = testContext();

  afterAll(async () => {
    await pool.end();
  });

  function account(label: string): string {
    return `user_hosted_${label}_${randomUUID().replaceAll("-", "")}`;
  }

  function commandName(command: unknown): string {
    return command instanceof Object ? command.constructor.name : "";
  }

  function commandInput(command: unknown): Record<string, unknown> {
    const input =
      command instanceof Object && "input" in command
        ? (command as { input: unknown }).input
        : undefined;
    return input instanceof Object ? (input as Record<string, unknown>) : {};
  }

  /** Programs the mocked bucket: `objects` is the live key set, and every
   * `DeleteObjects` request removes exactly the keys it names. Returns the
   * recorded delete batches so a test can assert how the request was split.
   */
  function bucketWithObjects(keys: readonly string[]): {
    readonly live: Set<string>;
    readonly deleteBatches: string[][];
  } {
    const live = new Set(keys);
    const deleteBatches: string[][] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      if (commandName(command) === "ListObjectsV2Command") {
        const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
        const maxKeys =
          typeof input.MaxKeys === "number" ? input.MaxKeys : 1000;
        const matching = [...live]
          .filter((key) => {
            return key.startsWith(prefix);
          })
          .sort();
        return Promise.resolve({
          Contents: matching.slice(0, maxKeys).map((key) => {
            return { Key: key, Size: 1, LastModified: nowDate() };
          }),
          IsTruncated: matching.length > maxKeys,
        });
      }
      if (commandName(command) === "DeleteObjectsCommand") {
        const remove =
          input.Delete instanceof Object && "Objects" in input.Delete
            ? (input.Delete as { Objects: { Key: string }[] }).Objects
            : [];
        deleteBatches.push(
          remove.map((object) => {
            return object.Key;
          }),
        );
        for (const object of remove) {
          live.delete(object.Key);
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    return { live, deleteBatches };
  }

  async function createDeployment(args: {
    readonly userId: string;
    readonly orgId: string;
    readonly siteId: string;
    readonly prefix: string;
    readonly private: boolean;
  }): Promise<string> {
    const deploymentId = randomUUID();
    const relation = args.private
      ? sql`private_hosted_deployments`
      : sql`hosted_deployments`;
    const artifactUrl = `https://artifacts.example.com/${deploymentId}`;
    await db.execute(
      sql`INSERT INTO ${relation}
            (id, site_id, org_id, user_id, public_brand, status, artifact_url,
             r2_prefix, manifest, manifest_hash, content_hash, file_count,
             size_bytes, url)
          VALUES (${deploymentId}, ${args.siteId}, ${args.orgId}, ${args.userId},
                  ${"vm0"}, ${"ready"}, ${artifactUrl}, ${args.prefix},
                  ${JSON.stringify({
                    version: 1,
                    deploymentId,
                    siteId: args.siteId,
                    publicSlug: `slug-${deploymentId}`,
                    createdAt: nowDate().toISOString(),
                    spaFallback: false,
                    files: {},
                  })}::jsonb,
                  ${"h".repeat(64)}, ${"c".repeat(64)}, ${1}, ${1},
                  ${`https://sites.example.com/${deploymentId}`})`,
    );
    return deploymentId;
  }

  async function createSite(userId: string, orgId: string): Promise<string> {
    const siteId = randomUUID();
    await db.execute(
      sql`INSERT INTO hosted_sites
            (id, org_id, user_id, slug, public_brand, public_slug)
          VALUES (${siteId}, ${orgId}, ${userId}, ${`s-${siteId.slice(0, 8)}`},
                  ${"vm0"}, ${`p-${siteId}`})`,
    );
    return siteId;
  }

  async function sealedJob(subjectId: string) {
    const selector = await encryptErasureSelector({
      version: 1,
      kind: "subject",
      subjectKind: "user",
      subjectId,
    });
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "objects",
      collectorVersion: HOSTED_SITE_ERASURE_COLLECTOR_VERSION,
      selector,
      dependencies: [],
    };
    const initial = await projectErasureDecision(db, {
      subjectKind: "user",
      subjectId,
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: new Date("2026-09-22T00:00:00Z"),
      deadlineAt: new Date("2090-01-01T00:00:00Z"),
    });
    return await reviseErasureInventory(db, initial.id, initial, [sink]);
  }

  async function capturedEveryPage(workId: string): Promise<boolean> {
    const result = await db.execute(
      sql`SELECT capture_complete FROM account_erasure_work WHERE id = ${workId}`,
    );
    return result.rows[0]?.capture_complete === true;
  }

  /** Runs the inventory phase and seals the capture, exactly as the future
   * worker must: no object is touched before this returns.
   *
   * One claim, then repeated execution on the lease it holds. A page commit
   * deliberately keeps that lease — `commitErasureInventoryPage` does not
   * clear `lease_id` the way `commitResult` does, and `claimErasureWork` skips
   * a row whose lease is still live — which is what stops two workers
   * interleaving pages and breaking the cursor chain that
   * `cursor_mismatch` enforces. Claiming again per page therefore yields
   * nothing after the first page, the collector item never reaches
   * `captureComplete`, and `sealErasureCapture` refuses with
   * `capture_incomplete`.
   */
  async function capture(subjectId: string) {
    const handler = createHostedSiteErasureCollector(db);
    const job = await sealedJob(subjectId);
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    expect(collector).toBeDefined();
    for (let page = 0; collector && page < 8; page += 1) {
      await executeErasureWork(db, collector, handler, context.signal);
      if (await capturedEveryPage(collector.workId)) {
        break;
      }
    }
    const sealed = await sealErasureCapture(
      db,
      job.id,
      job,
      {
        verify: () => {
          return Promise.resolve({
            jobId: job.id,
            generation: job.generation,
            captureRevision: job.captureRevision,
            inventoryRevision: job.inventoryRevision,
            reference: randomUUID(),
          });
        },
      },
      context.signal,
    );
    return { job, sealed, handler };
  }

  async function runVerification(
    jobId: string,
    handler: ReturnType<typeof createHostedSiteErasureCollector>,
  ): Promise<number> {
    let executed = 0;
    // `claimErasureWork` caps a claim at eight items, so allow enough rounds
    // for the largest fixture below to drain.
    for (let round = 0; round < 64; round += 1) {
      const claimed = await claimErasureWork(db, jobId, "verification");
      if (claimed.length === 0) {
        return executed;
      }
      for (const lease of claimed) {
        await executeErasureWork(db, lease, handler, context.signal);
        executed += 1;
      }
    }
    return executed;
  }

  it("deletes bytes whose catalog row is already gone", async () => {
    const userId = account("orphan");
    const orgId = `org_hosted_${randomUUID().replaceAll("-", "")}`;
    const prefix = `sites/${randomUUID()}`;
    const siteId = await createSite(userId, orgId);
    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM hosted_sites WHERE id = ${siteId}`);
    });
    await createDeployment({
      userId,
      orgId,
      siteId,
      prefix,
      private: false,
    });
    const bucket = bucketWithObjects([
      `${prefix}/index.html`,
      `${prefix}/assets/app.js`,
      // A sibling prefix that merely starts the same way must survive.
      `${prefix}-other/index.html`,
    ]);

    const captured = await capture(userId);

    // The relational sweep runs here in the real job: the row that held
    // `r2_prefix` is gone before a single object is deleted. The bytes must
    // still go, which is only possible because the locator was captured.
    await db.execute(
      sql`DELETE FROM hosted_deployments WHERE site_id = ${siteId}`,
    );

    // One captured prefix, plus the collector's own item, which owns the
    // enumeration rather than any object.
    await expect(
      runVerification(captured.job.id, captured.handler),
    ).resolves.toBe(2);
    expect([...bucket.live]).toStrictEqual([`${prefix}-other/index.html`]);

    const finished = await finalizeErasureJob(
      db,
      captured.job.id,
      captured.sealed,
    );
    expect(finished.state).toBe("verified_erased");
  });

  it("refuses to verify a captured prefix against a different bucket", async () => {
    const userId = account("bucket-drift");
    const orgId = `org_hosted_${randomUUID().replaceAll("-", "")}`;
    const prefix = `sites/${randomUUID()}`;
    const siteId = await createSite(userId, orgId);
    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM hosted_sites WHERE id = ${siteId}`);
    });
    await createDeployment({
      userId,
      orgId,
      siteId,
      prefix,
      private: false,
    });
    const key = `${prefix}/index.html`;
    const bucket = bucketWithObjects([key]);
    const captured = await capture(userId);
    const originalBucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!originalBucket) {
      throw new Error("Hosted sites bucket required by fixture");
    }
    mockEnv("R2_HOSTED_SITES_BUCKET_NAME", `${originalBucket}-new`);
    onTestFinished(() => {
      mockEnv("R2_HOSTED_SITES_BUCKET_NAME", originalBucket);
    });
    await runVerification(captured.job.id, captured.handler);
    expect(bucket.live.has(key)).toBeTruthy();
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");
  });

  it("splits a deployment larger than one delete request into bounded batches", async () => {
    const userId = account("large");
    const orgId = `org_hosted_${randomUUID().replaceAll("-", "")}`;
    const prefix = `sites/${randomUUID()}`;
    const siteId = await createSite(userId, orgId);
    onTestFinished(async () => {
      await db.execute(
        sql`DELETE FROM hosted_deployments WHERE site_id = ${siteId}`,
      );
      await db.execute(sql`DELETE FROM hosted_sites WHERE id = ${siteId}`);
    });
    await createDeployment({
      userId,
      orgId,
      siteId,
      prefix,
      private: false,
    });
    // Production has a deployment with 1,247 files, so a single site really
    // does exceed one `DeleteObjects` request.
    const keys = Array.from({ length: 2500 }, (_value, index) => {
      return `${prefix}/file-${index.toString().padStart(5, "0")}`;
    });
    const bucket = bucketWithObjects(keys);

    const captured = await capture(userId);
    await runVerification(captured.job.id, captured.handler);

    expect(bucket.live.size).toBe(0);
    expect(
      bucket.deleteBatches.map((batch) => {
        return batch.length;
      }),
    ).toStrictEqual([1000, 1000, 500]);
  });

  it("replays a deployment beyond the bounded lease before finalization", async () => {
    const userId = account("large-replay");
    const orgId = `org_hosted_${randomUUID().replaceAll("-", "")}`;
    const prefix = `sites/${randomUUID()}`;
    const siteId = await createSite(userId, orgId);
    onTestFinished(async () => {
      await db.execute(
        sql`DELETE FROM hosted_deployments WHERE site_id = ${siteId}`,
      );
      await db.execute(sql`DELETE FROM hosted_sites WHERE id = ${siteId}`);
    });
    await createDeployment({
      userId,
      orgId,
      siteId,
      prefix,
      private: false,
    });
    const bucket = bucketWithObjects(
      Array.from({ length: 10_005 }, (_value, index) => {
        return `${prefix}/file-${index.toString().padStart(5, "0")}`;
      }),
    );
    const captured = await capture(userId);
    await runVerification(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(5);
    expect(bucket.deleteBatches).toHaveLength(10);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");

    await db.execute(sql`UPDATE account_erasure_work
      SET available_at = clock_timestamp() - interval '1 second'
      WHERE job_id = ${captured.job.id} AND state = 'pending'`);
    await runVerification(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(0);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).resolves.toMatchObject({ state: "verified_erased" });
  });

  it("refuses to verify while an object remains under the captured prefix", async () => {
    const userId = account("residual");
    const orgId = `org_hosted_${randomUUID().replaceAll("-", "")}`;
    const prefix = `sites/${randomUUID()}`;
    const siteId = await createSite(userId, orgId);
    onTestFinished(async () => {
      await db.execute(
        sql`DELETE FROM hosted_deployments WHERE site_id = ${siteId}`,
      );
      await db.execute(sql`DELETE FROM hosted_sites WHERE id = ${siteId}`);
    });
    await createDeployment({
      userId,
      orgId,
      siteId,
      prefix,
      private: false,
    });
    const survivor = `${prefix}/kept.html`;
    const live = new Set([`${prefix}/index.html`, survivor]);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      if (commandName(command) === "ListObjectsV2Command") {
        const listPrefix = typeof input.Prefix === "string" ? input.Prefix : "";
        return Promise.resolve({
          Contents: [...live]
            .filter((key) => {
              return key.startsWith(listPrefix);
            })
            .map((key) => {
              return { Key: key, Size: 1, LastModified: nowDate() };
            }),
        });
      }
      if (commandName(command) === "DeleteObjectsCommand") {
        // The provider accepts the request and keeps one object anyway. Row
        // counts cannot see this; only reading the bucket back can.
        const remove =
          input.Delete instanceof Object && "Objects" in input.Delete
            ? (input.Delete as { Objects: { Key: string }[] }).Objects
            : [];
        for (const object of remove) {
          if (object.Key !== survivor) {
            live.delete(object.Key);
          }
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const captured = await capture(userId);
    await runVerification(captured.job.id, captured.handler);

    expect([...live]).toStrictEqual([survivor]);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");
  });

  it("enumerates both deployment tables in one ordered capture", async () => {
    const userId = account("both");
    const other = account("other");
    const orgId = `org_hosted_${randomUUID().replaceAll("-", "")}`;
    const siteId = await createSite(userId, orgId);
    onTestFinished(async () => {
      await db.execute(
        sql`DELETE FROM hosted_deployments WHERE site_id = ${siteId}`,
      );
      await db.execute(
        sql`DELETE FROM private_hosted_deployments WHERE site_id = ${siteId}`,
      );
      await db.execute(sql`DELETE FROM hosted_sites WHERE id = ${siteId}`);
    });
    const publicPrefix = `sites/${randomUUID()}`;
    const privatePrefix = `sites/${randomUUID()}`;
    const otherPrefix = `sites/${randomUUID()}`;
    await createDeployment({
      userId,
      orgId,
      siteId,
      prefix: publicPrefix,
      private: false,
    });
    await createDeployment({
      userId,
      orgId,
      siteId,
      prefix: privatePrefix,
      private: true,
    });
    // Another member's deployment under the same site must not be captured.
    await createDeployment({
      userId: other,
      orgId,
      siteId,
      prefix: otherPrefix,
      private: false,
    });

    const prefixes = await hostedSiteErasurePrefixPage(db, {
      subjectKind: "user",
      subjectId: userId,
    });
    expect(prefixes).toStrictEqual([
      { relation: "hosted_deployments", prefix: publicPrefix },
      { relation: "private_hosted_deployments", prefix: privatePrefix },
    ]);

    const bucket = bucketWithObjects([
      `${publicPrefix}/index.html`,
      `${privatePrefix}/index.html`,
      `${otherPrefix}/index.html`,
    ]);
    const captured = await capture(userId);
    // Two captured prefixes plus the collector's own item.
    await expect(
      runVerification(captured.job.id, captured.handler),
    ).resolves.toBe(3);
    expect([...bucket.live]).toStrictEqual([`${otherPrefix}/index.html`]);
  });
});

/* eslint-disable no-restricted-syntax -- B1 collector has no API route until the shared deletion executor is wired. */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { artifactDeliveryKey } from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  claimErasureWork,
  executeErasureWork,
  finalizeErasureJob,
  projectErasureDecision,
  reviseErasureInventory,
  sealErasureCapture,
  type ErasureSink,
} from "@okouai/db/operations/account-erasure";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import {
  ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION,
  createArtifactShareErasureCollector,
} from "../account-erasure-artifact-share-collector";
import { encryptErasureSelector } from "../account-erasure-selector";

describe("artifact share policy, alias and snapshot erasure", () => {
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.searchParams.set(
    "application_name",
    `erasure_share_${randomUUID()}`,
  );
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 8 });
  const db = drizzle(pool);
  const context = testContext();

  afterAll(async () => {
    await pool.end();
  });

  function bucketWithObjects(
    keys: readonly string[],
    records: ReadonlyMap<string, string>,
  ) {
    const live = new Set(keys);
    const deleted: string[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input =
        command instanceof Object && "input" in command
          ? (command as { input: Record<string, unknown> }).input
          : {};
      switch (command instanceof Object ? command.constructor.name : "") {
        case "HeadObjectCommand": {
          return live.has(String(input.Key))
            ? Promise.resolve({ ContentLength: 1 })
            : Promise.reject(
                Object.assign(new Error("absent"), { name: "NoSuchKey" }),
              );
        }
        case "GetObjectCommand": {
          const body = records.get(String(input.Key));
          return body !== undefined && live.has(String(input.Key))
            ? Promise.resolve({
                Body: Readable.from([Buffer.from(body)]),
                ETag: '"policy"',
              })
            : Promise.reject(
                Object.assign(new Error("absent"), { name: "NoSuchKey" }),
              );
        }
        case "ListObjectsV2Command": {
          const prefix = String(input.Prefix ?? "");
          const maxKeys =
            typeof input.MaxKeys === "number" ? input.MaxKeys : 1000;
          const matching = [...live]
            .filter((key) => {
              return key.startsWith(prefix);
            })
            .sort();
          return Promise.resolve({
            Contents: matching.slice(0, maxKeys).map((Key) => {
              return { Key, Size: 1, LastModified: nowDate() };
            }),
            IsTruncated: matching.length > maxKeys,
          });
        }
        case "DeleteObjectsCommand": {
          const objects =
            input.Delete instanceof Object && "Objects" in input.Delete
              ? (input.Delete as { Objects: { Key: string }[] }).Objects
              : [];
          for (const object of objects) {
            deleted.push(object.Key);
            live.delete(object.Key);
          }
          return Promise.resolve({});
        }
        default: {
          return Promise.resolve({});
        }
      }
    });
    return { live, deleted };
  }

  async function shareRow(
    userId: string,
    kind: "file" | "html",
    targetId: string,
  ) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO artifact_shares (id, user_id, org_id, public_brand, target_kind, target_id) VALUES ($1, $2, $3, 'vm0', $4, $5)",
      [id, userId, "org_" + id, kind, targetId],
    );
    onTestFinished(async () => {
      await pool.query("DELETE FROM artifact_shares WHERE id = $1", [id]);
    });
    return { id, orgId: "org_" + id };
  }

  async function capture(userId: string) {
    const subject = await encryptErasureSelector({
      version: 1,
      kind: "subject",
      subjectKind: "user",
      subjectId: userId,
    });
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "objects",
      collectorVersion: ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION,
      selector: subject,
      dependencies: [],
    };
    const initial = await projectErasureDecision(db, {
      subjectKind: "user",
      subjectId: userId,
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: new Date("2026-09-23T00:00:00Z"),
      deadlineAt: new Date("2090-01-01T00:00:00Z"),
    });
    const job = await reviseErasureInventory(db, initial.id, initial, [sink]);
    const handler = createArtifactShareErasureCollector(db);
    for (let page = 0; page < 4; page += 1) {
      const [lease] = await claimErasureWork(db, job.id, "inventory");
      if (!lease) {
        break;
      }
      await executeErasureWork(db, lease, handler, context.signal);
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

  async function erase(
    jobId: string,
    handler: ReturnType<typeof createArtifactShareErasureCollector>,
  ) {
    for (let page = 0; page < 4; page += 1) {
      const claims = await claimErasureWork(db, jobId, "verification");
      if (claims.length === 0) {
        break;
      }
      for (const claim of claims) {
        await executeErasureWork(db, claim, handler, context.signal);
      }
    }
  }

  it("removes both public site aliases and selected copy after its catalog row disappears", async () => {
    const userId = `user_share_${randomUUID()}`;
    const deploymentId = randomUUID();
    const siteId = randomUUID();
    const snapshotId = randomUUID();
    const share = await shareRow(userId, "html", deploymentId);
    const token = "0123456789abcdef01234567";
    const slug = "published-test";
    const policyKey = `artifact-shares/vm0/${share.id}.json`;
    const tokenKey = artifactDeliveryKey("vm0", "html", token);
    const slugKey = artifactDeliveryKey("vm0", "html", slug);
    const copy = `shared-artifacts/vm0/${snapshotId}/${deploymentId}/index.html`;
    const policy = {
      version: 1,
      revision: randomUUID(),
      shareId: share.id,
      ownerId: userId,
      orgId: share.orgId,
      publicBrand: "vm0",
      delivery: "artifact-registry-v1",
      audience: "public",
      status: "active",
      publicToken: token,
      publicSlug: slug,
      target: {
        kind: "html",
        id: deploymentId,
        siteId,
        snapshotId,
        deploymentVersion: 1,
        manifest: {
          version: 1,
          access: "owner-private-v1",
          publicBrand: "vm0",
          deploymentId,
          siteId,
          publicSlug: slug,
          createdAt: nowDate().toISOString(),
          spaFallback: false,
          files: {},
        },
      },
    };
    const alias = JSON.stringify({
      version: 1,
      kind: "publication",
      publicBrand: "vm0",
      shareId: share.id,
      publicToken: token,
      targetKind: "html",
    });
    const bucket = bucketWithObjects(
      [policyKey, tokenKey, slugKey, copy],
      new Map([
        [policyKey, JSON.stringify(policy)],
        [tokenKey, alias],
        [slugKey, alias],
      ]),
    );
    const captured = await capture(userId);
    await pool.query("DELETE FROM artifact_shares WHERE id = $1", [share.id]);
    await erase(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(0);
    expect(bucket.deleted.sort()).toStrictEqual(
      [policyKey, tokenKey, slugKey, copy].sort(),
    );
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");
  });

  it("replays a large selected snapshot without completing its work early", async () => {
    const userId = `user_share_${randomUUID()}`;
    const deploymentId = randomUUID();
    const siteId = randomUUID();
    const snapshotId = randomUUID();
    const share = await shareRow(userId, "html", deploymentId);
    const policyKey = `artifact-shares/vm0/${share.id}.json`;
    const prefix = `shared-artifacts/vm0/${snapshotId}/${deploymentId}`;
    const policy = {
      version: 1,
      revision: randomUUID(),
      shareId: share.id,
      ownerId: userId,
      orgId: share.orgId,
      publicBrand: "vm0",
      delivery: "artifact-registry-v1",
      audience: "organization",
      status: "active",
      publicToken: null,
      target: {
        kind: "html",
        id: deploymentId,
        siteId,
        snapshotId,
        deploymentVersion: 1,
        manifest: {
          version: 1,
          access: "owner-private-v1",
          publicBrand: "vm0",
          deploymentId,
          siteId,
          publicSlug: "large-snapshot",
          createdAt: nowDate().toISOString(),
          spaFallback: false,
          files: {},
        },
      },
    };
    const bucket = bucketWithObjects(
      [
        policyKey,
        ...Array.from({ length: 10_005 }, (_value, index) => {
          return `${prefix}/file-${index.toString().padStart(5, "0")}`;
        }),
      ],
      new Map([[policyKey, JSON.stringify(policy)]]),
    );
    const captured = await capture(userId);
    await pool.query("DELETE FROM artifact_shares WHERE id = $1", [share.id]);
    await erase(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(5);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");

    await pool.query(
      "UPDATE account_erasure_work SET available_at = clock_timestamp() - interval '1 second' WHERE job_id = $1 AND state = 'pending'",
      [captured.job.id],
    );
    await erase(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(0);
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM account_erasure_work WHERE job_id = $1 AND kind = 'erase' ORDER BY state",
      [captured.job.id],
    );
    expect(
      result.rows.map((row) => {
        return row.state;
      }),
    ).toStrictEqual(["capability_unresolved", "verified_erased"]);
  });

  it("removes a private file snapshot and its public file alias after row deletion", async () => {
    const userId = `user_share_${randomUUID()}`;
    const fileId = randomUUID();
    const share = await shareRow(userId, "file", fileId);
    const token = "abcdef0123456789abcdef01";
    const privateKey = `private-artifacts/${fileId}/shares/${randomUUID()}/report.txt`;
    const policyKey = `artifact-shares/vm0/${share.id}.json`;
    const aliasKey = artifactDeliveryKey(null, "file", `${token}.txt`);
    const reference = "abcdefghij";
    const referenceKey = `artifact-references/${reference}.json`;
    const policy = {
      version: 1,
      revision: randomUUID(),
      shareId: share.id,
      ownerId: userId,
      orgId: share.orgId,
      publicBrand: "vm0",
      delivery: "artifact-registry-v1",
      audience: "public",
      status: "active",
      publicToken: token,
      organizationReference: reference,
      target: {
        kind: "file",
        id: fileId,
        key: privateKey,
        filename: "report.txt",
        contentType: "text/plain",
      },
    };
    const alias = JSON.stringify({
      version: 1,
      kind: "publication",
      publicBrand: "vm0",
      shareId: share.id,
      publicToken: token,
      targetKind: "file",
    });
    const bucket = bucketWithObjects(
      [policyKey, aliasKey, referenceKey, privateKey],
      new Map([
        [policyKey, JSON.stringify(policy)],
        [aliasKey, alias],
        [
          referenceKey,
          JSON.stringify({ version: 2, target: { kind: "file", id: fileId } }),
        ],
      ]),
    );
    const captured = await capture(userId);
    await pool.query("DELETE FROM artifact_shares WHERE id = $1", [share.id]);
    await erase(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(0);
    expect(bucket.deleted.sort()).toStrictEqual(
      [policyKey, aliasKey, referenceKey, privateKey].sort(),
    );
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");
  });
});

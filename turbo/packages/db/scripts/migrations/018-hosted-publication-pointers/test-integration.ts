import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import {
  activeKey,
  aliasKey,
  bootstrapId,
  buildManifest,
  buildPointer,
  contentHash,
  deploymentPointerKey,
  legacyRecord,
  planSchema,
  policySchema,
  prefix,
  publicationRecord,
  sha256,
  type PlanSite,
} from "./model";
import {
  storageStateSchema,
  testEnvironment,
  type StorageState,
} from "./test-storage";

const configuredUrl = testEnvironment.HOSTED_MIGRATION_TEST_DATABASE_URL;
const allowedUrl = configuredUrl ? new URL(configuredUrl) : null;
if (allowedUrl) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]", "postgres"].includes(
      allowedUrl.hostname,
    ),
    "Integration fixture database must be local",
  );
  assert.match(
    allowedUrl.pathname,
    /test/iu,
    "Use an explicitly named test database with current migrations",
  );
}
const directory = fileURLToPath(new URL(".", import.meta.url));

async function state(path: string) {
  return storageStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function jsonObject(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    bytes: bytes.toString("base64"),
    contentType: "application/json",
    etag: `"${sha256(bytes)}"`,
  };
}

function objectJson(storage: StorageState, key: string): unknown {
  const object = storage.objects[key];
  assert.ok(object, `Missing test object: ${key}`);
  return JSON.parse(Buffer.from(object.bytes, "base64").toString("utf8"));
}

async function cli(args: {
  connection: string;
  statePath: string;
  orgId: string;
  siteId: string;
  planPath: string;
  flags?: string[];
}) {
  return await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        join(directory, "test-storage.ts"),
        join(directory, "backfill.ts"),
        "--org-id",
        args.orgId,
        "--site-id",
        args.siteId,
        "--plan",
        args.planPath,
        ...(args.flags ?? []),
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: args.connection,
          HOSTED_MIGRATION_TEST_STORAGE: args.statePath,
          R2_ACCOUNT_ID: "migration018-test",
          R2_HOSTED_SITES_BUCKET_NAME: "migration018-test-bucket",
          R2_HOSTED_SITES_ACCESS_KEY_ID: "test-access",
          R2_HOSTED_SITES_SECRET_ACCESS_KEY: "test-secret",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

await test(
  "CLI dry-run, real SQL apply, partial CAS recovery, idempotent retry and verification",
  {
    skip: !configuredUrl,
    timeout: 60_000,
  },
  async () => {
    assert.ok(configuredUrl);
    const db = new Client({ connectionString: configuredUrl });
    const folder = await mkdtemp(join(tmpdir(), "hosted-migration-018-"));
    const orgId = `migration018-test-${randomUUID()}`;
    const ownerId = `migration018-owner-${randomUUID()}`;
    const siteId = randomUUID();
    const sourceId = randomUUID();
    const pendingId = randomUUID();
    const shareId = randomUUID();
    const slug = `migration018-${randomUUID()}`;
    const bytes = Buffer.from(
      "<!doctype html><title>Preserved snapshot</title>",
    );
    const file = {
      path: "/index.html",
      size: bytes.byteLength,
      sha256: sha256(bytes),
      contentType: "text/html",
    };
    const source = {
      version: 1,
      immutableContent: true,
      access: "owner-private-v1",
      publicBrand: "okou",
      deploymentId: sourceId,
      siteId,
      publicSlug: slug,
      site: slug,
      deploymentVersion: 3,
      createdAt: "2026-09-18T00:00:00.000Z",
      artifactKind: "presentation-html",
      spaFallback: false,
      files: { "/index.html": file },
    };
    const policy = policySchema.parse({
      version: 1,
      revision: randomUUID(),
      shareId,
      ownerId,
      orgId,
      publicBrand: "okou",
      delivery: "artifact-registry-v1",
      publicSlug: slug,
      audience: "public",
      status: "active",
      publicToken: randomUUID().replaceAll("-", "").slice(0, 24),
      target: {
        kind: "html",
        id: sourceId,
        siteId,
        snapshotId: randomUUID(),
        deploymentVersion: 3,
        manifest: source,
      },
    });
    const planned: PlanSite = {
      siteId,
      ownerId,
      publicBrand: "okou",
      publicSlug: slug,
      requestedSlug: slug,
      shareId,
      publicToken: policy.publicToken,
      source: policy.target,
      sourceEtags: {},
      artifactKind: "presentation-html",
      deploymentId: bootstrapId(orgId, policy.target),
      createdAt: source.createdAt,
    };
    const sourcePrefix = `shared-artifacts/okou/${policy.target.snapshotId}/${sourceId}`;
    const policyKey = `artifact-shares/okou/${shareId}.json`;
    const namedKey = aliasKey(planned, slug);
    const tokenKey = aliasKey(planned, policy.publicToken);
    const fixture: StorageState = {
      objects: {
        [policyKey]: jsonObject(policy),
        [namedKey]: jsonObject(publicationRecord(planned)),
        [tokenKey]: jsonObject(publicationRecord(planned)),
        [`${sourcePrefix}/manifest.json`]: jsonObject(source),
        [`${sourcePrefix}/index.html`]: {
          bytes: bytes.toString("base64"),
          contentType: "text/html",
          etag: '"source-etag"',
        },
      },
      puts: 0,
      failAlias: null,
      failuresRemaining: 0,
    };
    const statePath = join(folder, "storage.json");
    const planPath = join(folder, "plan.json");
    const command = {
      connection: configuredUrl,
      statePath,
      orgId,
      siteId,
      planPath,
    };
    await db.connect();
    try {
      await db.query(
        "INSERT INTO hosted_sites (id, org_id, user_id, slug, requested_slug, public_brand, public_slug) VALUES ($1, $2, $3, $4, $4, 'okou', $4)",
        [siteId, orgId, ownerId, slug],
      );
      await db.query(
        `INSERT INTO private_hosted_deployments
      (id, site_id, org_id, user_id, public_brand, status, artifact_url, r2_prefix, manifest, manifest_hash, content_hash, file_count, size_bytes, url)
      VALUES ($1, $2, $3, $4, 'okou', 'ready', $5, $6, $7, $8, $9, 1, $10, $5)`,
        [
          sourceId,
          siteId,
          orgId,
          ownerId,
          `https://app.okou.ai/artifacts/${sourceId}`,
          `private-sites/okou/${sourceId}`,
          source,
          sha256(JSON.stringify(source)),
          contentHash([file]),
          file.size,
        ],
      );
      await db.query(
        "INSERT INTO artifact_shares (id, org_id, user_id, public_brand, target_kind, target_id) VALUES ($1, $2, $3, 'okou', 'html', $4)",
        [shareId, orgId, ownerId, siteId],
      );
      // The older bootstrap must not consume version 5 and outrank this pending 4.
      const pending = {
        ...buildManifest(planned),
        deploymentId: pendingId,
        deploymentVersion: 4,
      };
      await db.query(
        `INSERT INTO hosted_deployments
      (id, site_id, org_id, user_id, public_brand, status, r2_prefix, manifest, manifest_hash, content_hash, file_count, size_bytes, url)
      VALUES ($1, $2, $3, $4, 'okou', 'uploading', $5, $6, $7, $8, 1, $9, $10)`,
        [
          pendingId,
          siteId,
          orgId,
          ownerId,
          `sites/brands/okou/publications/${pendingId}`,
          pending,
          sha256(JSON.stringify(pending)),
          contentHash([file]),
          file.size,
          `https://${slug}.okou.app`,
        ],
      );
      await writeFile(statePath, JSON.stringify(fixture));

      const dry = await cli(command);
      assert.equal(dry.code, 0, dry.stderr);
      assert.deepEqual(
        await state(statePath),
        fixture,
        "dry-run must issue no R2 PUT",
      );
      assert.equal(
        (
          await db.query(
            "SELECT id FROM hosted_deployments WHERE site_id = $1",
            [siteId],
          )
        ).rows.length,
        1,
      );
      const plan = planSchema.parse(
        JSON.parse(await readFile(planPath, "utf8")),
      );
      assert.equal(plan.sites[0]?.source.deploymentVersion, 3);

      await writeFile(
        statePath,
        JSON.stringify({
          ...fixture,
          failAlias: namedKey,
          failuresRemaining: 1,
        }),
      );
      const interrupted = await cli({ ...command, flags: ["--migrate"] });
      assert.equal(interrupted.code, 1);
      const partial = await state(statePath);
      assert.deepEqual(
        objectJson(partial, namedKey),
        publicationRecord(planned),
      );
      assert.ok(
        partial.objects[activeKey(planned)],
        "complete active pointer precedes alias CAS",
      );
      assert.equal(
        policySchema.parse(objectJson(partial, policyKey)).publicSlug,
        undefined,
      );
      assert.equal(
        (
          await db.query(
            "SELECT active_deployment_id FROM hosted_sites WHERE id = $1",
            [siteId],
          )
        ).rows[0]?.active_deployment_id,
        null,
      );
      assert.equal(
        (
          await db.query(
            "SELECT status FROM hosted_deployments WHERE id = $1",
            [planned.deploymentId],
          )
        ).rows[0]?.status,
        "uploading",
      );
      assert.equal(
        (
          await db.query("SELECT id FROM artifacts WHERE logical_key = $1", [
            `site:${siteId}`,
          ])
        ).rows.length,
        0,
        "catalog rolls back with failed bind",
      );

      const applied = await cli({ ...command, flags: ["--migrate"] });
      assert.equal(applied.code, 0, applied.stderr);
      const completed = await state(statePath);
      assert.deepEqual(objectJson(completed, namedKey), legacyRecord(planned));
      assert.deepEqual(completed.objects[tokenKey], fixture.objects[tokenKey]);
      assert.deepEqual(
        completed.objects[`${sourcePrefix}/index.html`],
        fixture.objects[`${sourcePrefix}/index.html`],
      );
      assert.equal(
        completed.objects[`${prefix(planned)}/index.html`]?.bytes,
        bytes.toString("base64"),
      );
      const projection = z
        .object({
          kind: z.string(),
          author_user_id: z.string(),
          hosted_site_id: z.uuid(),
        })
        .parse(
          (
            await db.query(
              `SELECT a.kind, a.author_user_id, p.hosted_site_id
      FROM artifacts a JOIN presentation_artifacts p ON p.id = a.entity_id WHERE a.logical_key = $1`,
              [`site:${siteId}`],
            )
          ).rows[0],
        );
      assert.deepEqual(projection, {
        kind: "presentation",
        author_user_id: ownerId,
        hosted_site_id: siteId,
      });
      assert.equal(
        (
          await db.query(
            "SELECT active_deployment_id FROM hosted_sites WHERE id = $1",
            [siteId],
          )
        ).rows[0]?.active_deployment_id,
        planned.deploymentId,
      );
      assert.equal(
        (
          await db.query(
            "SELECT status FROM hosted_deployments WHERE id = $1",
            [pendingId],
          )
        ).rows[0]?.status,
        "uploading",
      );

      const repeated = await cli({ ...command, flags: ["--migrate"] });
      assert.equal(repeated.code, 0, repeated.stderr);
      assert.deepEqual(
        await state(statePath),
        completed,
        "idempotent retry performs no additional R2 writes",
      );
      const verified = await cli({ ...command, flags: ["--verify"] });
      assert.equal(verified.code, 0, verified.stderr);
      assert.deepEqual(
        await state(statePath),
        completed,
        "independent verification performs no writes",
      );

      // A normal newer publication arriving after bootstrap must remain active
      // even when an operator accidentally replays the old migration plan.
      const newer = {
        ...completed,
        objects: {
          ...completed.objects,
          [activeKey(planned)]: jsonObject({
            ...buildPointer(planned),
            deploymentId: pendingId,
            deploymentVersion: 4,
            prefix: `sites/brands/okou/publications/${pendingId}`,
            manifestKey: `sites/brands/okou/publications/${pendingId}/manifest.json`,
            artifactUrl: `https://dpl-${pendingId}.okou.app`,
          }),
        },
      };
      await writeFile(statePath, JSON.stringify(newer));
      await db.query(
        "UPDATE hosted_deployments SET status = 'ready' WHERE id = $1",
        [pendingId],
      );
      await db.query(
        "UPDATE hosted_sites SET active_deployment_id = $1 WHERE id = $2",
        [pendingId, siteId],
      );
      const outdated = await cli({ ...command, flags: ["--migrate"] });
      assert.equal(outdated.code, 1);
      assert.deepEqual(
        await state(statePath),
        newer,
        "old plan cannot overwrite a newer pointer",
      );
      assert.equal(
        (
          await db.query(
            "SELECT active_deployment_id FROM hosted_sites WHERE id = $1",
            [siteId],
          )
        ).rows[0]?.active_deployment_id,
        pendingId,
      );

      // Restore only this fixture to its original state and let revocation win
      // during public file staging, before the final site/share locks are held.
      await db.query(
        "UPDATE hosted_sites SET active_deployment_id = NULL WHERE id = $1",
        [siteId],
      );
      await db.query("DELETE FROM artifacts WHERE org_id = $1", [orgId]);
      await db.query(
        "DELETE FROM presentation_artifacts WHERE hosted_site_id = $1",
        [siteId],
      );
      await db.query("DELETE FROM hosted_deployments WHERE id = $1", [
        planned.deploymentId,
      ]);
      await db.query(
        "UPDATE hosted_deployments SET status = 'uploading' WHERE id = $1",
        [pendingId],
      );
      await writeFile(
        statePath,
        JSON.stringify({
          ...fixture,
          revokeOnPut: {
            key: `${prefix(planned)}/index.html`,
            policyKey,
          },
        }),
      );
      const revoked = await cli({ ...command, flags: ["--migrate"] });
      assert.equal(revoked.code, 1);
      const afterRevocation = await state(statePath);
      assert.ok(
        afterRevocation.objects[`${prefix(planned)}/index.html`],
        "bytes were staged before revocation",
      );
      assert.equal(
        afterRevocation.objects[
          aliasKey(planned, `dpl-${planned.deploymentId}`)
        ],
        undefined,
        "revoked snapshot must not acquire an immutable public URL",
      );
      assert.equal(
        afterRevocation.objects[deploymentPointerKey(planned)],
        undefined,
      );
      assert.equal(afterRevocation.objects[activeKey(planned)], undefined);
      assert.deepEqual(
        objectJson(afterRevocation, namedKey),
        publicationRecord(planned),
      );
      assert.equal(
        (
          await db.query(
            "SELECT active_deployment_id FROM hosted_sites WHERE id = $1",
            [siteId],
          )
        ).rows[0]?.active_deployment_id,
        null,
      );
      assert.equal(
        (
          await db.query("SELECT id FROM artifacts WHERE logical_key = $1", [
            `site:${siteId}`,
          ])
        ).rows.length,
        0,
      );
    } finally {
      await db.query("DELETE FROM artifacts WHERE org_id = $1", [orgId]);
      await db.query("DELETE FROM artifact_shares WHERE org_id = $1", [orgId]);
      await db.query("DELETE FROM hosted_sites WHERE org_id = $1", [orgId]);
      await db.end();
      await rm(folder, { recursive: true, force: true });
    }
  },
);

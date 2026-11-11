import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { c as createTar } from "tar";
import { sha256, writePrivate } from "./execution-model";
import {
  validateProductionConnection,
  verifyLiveMembers,
} from "./production-guards";
import {
  BRANCH,
  BUCKET,
  ENDPOINT,
  PROJECT,
  STAFF_ORG,
  type ProductionMetadata,
} from "./production-model";
import {
  packageKey,
  sealBytes,
  sealExecutionDirectory,
} from "./production-package";

const execute = promisify(execFile);
const directory = await mkdtemp(
  join(tmpdir(), "single-agent-production-test-"),
);
const cli = fileURLToPath(new URL("./production.ts", import.meta.url));
const packaging = fileURLToPath(
  new URL("./production-package-cli.ts", import.meta.url),
);
const peer = fileURLToPath(
  new URL("./fixtures/production-peer.ts", import.meta.url),
);
const revision = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
const key = randomBytes(32).toString("hex");
const canary =
  "private-recovery-content-must-never-appear-in-artifacts-or-stdout";
const server = setupServer();
server.listen({ onUnhandledRequest: "error" });
let counter = 0;

async function invoke(
  file: string,
  args: string[],
  fixture: string,
  success = true,
) {
  const child = await execute(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--import",
      peer,
      file,
      ...args,
      "--peer-fixture",
      fixture,
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NEON_API_KEY: "synthetic-neon",
        CLERK_SECRET_KEY: "synthetic-clerk",
        R2_ENDPOINT: ENDPOINT,
        R2_USER_STORAGES_BUCKET_NAME: BUCKET,
        R2_ACCESS_KEY_ID: "synthetic-access",
        R2_SECRET_ACCESS_KEY: "synthetic-secret",
      },
      timeout: 30_000,
    },
  ).then(
    (result) => {
      return { ...result, code: 0 };
    },
    (error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("stdout" in error) ||
        !("stderr" in error)
      )
        throw error;
      return {
        stdout: String(error.stdout),
        stderr: String(error.stderr),
        code: 1,
      };
    },
  );
  assert.equal(child.code, success ? 0 : 1, child.stderr);
  assert.ok(!child.stdout.includes(canary) && !child.stderr.includes(canary));
  assert.ok(!child.stdout.includes(key) && !child.stderr.includes(key));
  return child;
}
async function request(minimumCu = 8) {
  const root = join(directory, String(++counter));
  await mkdir(root, { mode: 0o700 });
  const fixture = join(root, "peer.json");
  await writePrivate(fixture, JSON.stringify({ minimumCu }));
  return { root, fixture };
}

try {
  const target = await request();
  const result = await invoke(
    cli,
    ["target", "--org-id", STAFF_ORG],
    target.fixture,
  );
  assert.match(result.stdout, /"minimumCu":8/u);
  assert.deepEqual(await readdir(target.root), ["peer.json"]);
  const tooSmall = await request(1);
  assert.match(
    (
      await invoke(
        cli,
        ["target", "--org-id", STAFF_ORG],
        tooSmall.fixture,
        false,
      )
    ).stderr,
    /ProductionRequiresProvisionedEightComputeUnits/u,
  );
  // Omitting the mode selects read-only planning, never an apply.
  assert.match(
    (await invoke(cli, ["--org-id", STAFF_ORG], target.fixture, false)).stderr,
    /PrivateDirectoryAndKeyFileRequired/u,
  );
  assert.match(
    (
      await invoke(
        cli,
        [
          "apply",
          "--org-id",
          STAFF_ORG,
          "--directory",
          join(directory, "attempt"),
          "--key-file",
          join(directory, "key"),
          "--plan-directory",
          join(directory, "reviewed"),
          "--expect-plan-sha256",
          "a".repeat(64),
          "--expect-image-sha256",
          "b".repeat(64),
        ],
        target.fixture,
        false,
      )
    ).stderr,
    /MutationRequiresMigrateAndDrainedWriters/u,
  );

  const execution = join(directory, "execution");
  await mkdir(execution, { mode: 0o700 });
  await mkdir(join(execution, "bundles"), { mode: 0o700 });
  const bytes = Buffer.from(JSON.stringify({ privateContent: canary }));
  await writePrivate(join(execution, "execution.json"), bytes);
  const bundleName = `${"e".repeat(64)}.tar.gz`;
  await writePrivate(
    join(execution, "bundles", bundleName),
    Buffer.from("immutable-bundle"),
  );
  const receiptName = `${randomUUID()}-complete.json`;
  await writePrivate(join(execution, receiptName), "{}\n");
  const metadata: ProductionMetadata = {
    format: "single-agent-production-plan-v1",
    binding: {
      projectId: PROJECT,
      branchId: BRANCH,
      endpointId: "ep-production-fixture",
      commit: revision,
      planId: randomUUID(),
      orgId: STAFF_ORG,
    },
    createdAt: "2026-11-11T00:00:00.000Z",
    inventorySha256: "a".repeat(64),
    planSha256: "b".repeat(64),
    imageSha256: sha256(bytes),
    prefixesSha256: "c".repeat(64),
    summary: { workflowMoves: 1 },
  };
  const metadataFile = join(directory, "metadata.json"),
    keyFile = join(directory, "key"),
    encrypted = join(directory, "execution.enc");
  await writePrivate(metadataFile, JSON.stringify(metadata));
  await writePrivate(keyFile, key + "\n");
  await sealExecutionDirectory(
    execution,
    encrypted,
    packageKey(key),
    JSON.stringify(metadata),
  );
  assert.ok(!(await readFile(encrypted)).includes(canary));

  // A local plan with different approved hashes must fail before loading any DB credential.
  const reviewed = join(directory, "reviewed");
  await mkdir(reviewed, { mode: 0o700 });
  await writePrivate(join(reviewed, "metadata.json"), JSON.stringify(metadata));
  await writePrivate(
    join(reviewed, "execution.enc"),
    await readFile(encrypted),
  );
  await writePrivate(
    join(reviewed, "audit.json"),
    JSON.stringify({
      mode: "plan",
      completed: true,
      commit: revision,
      imageSha256: metadata.imageSha256,
    }),
  );
  assert.match(
    (
      await invoke(
        cli,
        [
          "apply",
          "--org-id",
          STAFF_ORG,
          "--plan-directory",
          reviewed,
          "--expect-plan-sha256",
          metadata.planSha256,
          "--expect-image-sha256",
          "d".repeat(64),
          "--key-file",
          keyFile,
          "--directory",
          join(directory, "wrong-plan-attempt"),
          "--writers-drained",
          "--migrate",
        ],
        target.fixture,
        false,
      )
    ).stderr,
    /ReviewedProductionMetadataMismatch/u,
  );
  await assert.rejects(stat(join(directory, "wrong-plan-attempt")), {
    code: "ENOENT",
  });

  const opened = join(directory, "opened");
  await invoke(
    packaging,
    [
      "open",
      "--input",
      encrypted,
      "--output",
      opened,
      "--key-file",
      keyFile,
      "--metadata",
      metadataFile,
    ],
    target.fixture,
  );
  assert.deepEqual(await readFile(join(opened, "execution.json")), bytes);
  assert.equal((await stat(opened)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(opened, "execution.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    await readFile(join(opened, "bundles", bundleName), "utf8"),
    "immutable-bundle",
  );
  assert.ok((await readdir(opened)).includes(receiptName));

  const tampered = await readFile(encrypted);
  tampered[tampered.length - 1] = tampered.at(-1)! ^ 1;
  const tamperedFile = join(directory, "tampered.enc"),
    rejected = join(directory, "rejected");
  await writeFile(tamperedFile, tampered);
  assert.match(
    (
      await invoke(
        packaging,
        [
          "open",
          "--input",
          tamperedFile,
          "--output",
          rejected,
          "--key-file",
          keyFile,
          "--metadata",
          metadataFile,
        ],
        target.fixture,
        false,
      )
    ).stderr,
    /ProductionPackageAuthenticationFailed/u,
  );
  await assert.rejects(stat(rejected), { code: "ENOENT" });

  const malicious = join(directory, "malicious");
  await mkdir(malicious, { mode: 0o700 });
  await writePrivate(join(malicious, "unexpected.json"), canary);
  const chunks: Buffer[] = [];
  for await (const chunk of createTar(
    { cwd: malicious, gzip: true, portable: true },
    ["unexpected.json"],
  ))
    chunks.push(Buffer.from(chunk));
  const maliciousFile = join(directory, "malicious.enc");
  await writePrivate(
    maliciousFile,
    sealBytes(Buffer.concat(chunks), packageKey(key), JSON.stringify(metadata)),
  );
  assert.match(
    (
      await invoke(
        packaging,
        [
          "open",
          "--input",
          maliciousFile,
          "--output",
          rejected,
          "--key-file",
          keyFile,
          "--metadata",
          metadataFile,
        ],
        target.fixture,
        false,
      )
    ).stderr,
    /InvalidProductionPackageContents/u,
  );
  await assert.rejects(stat(rejected), { code: "ENOENT" });
  await symlink(
    keyFile,
    join(execution, "bundles", `${"f".repeat(64)}.tar.gz`),
  );
  await assert.rejects(
    sealExecutionDirectory(
      execution,
      join(directory, "symlink.enc"),
      packageKey(key),
      "scope",
    ),
  );

  const connection = validateProductionConnection(
    "postgresql://RO:synthetic@fixture.neon.tech/neondb?sslmode=require",
    "fixture.neon.tech",
    false,
  );
  assert.equal(connection.role, "RO");
  assert.equal(
    new URL(connection.connection).searchParams.get("sslmode"),
    "verify-full",
  );
  assert.throws(() => {
    validateProductionConnection(
      "postgresql://RO:synthetic@another.neon.tech/neondb",
      "fixture.neon.tech",
      false,
    );
  }, /ProductionConnectionIdentityRejected/u);

  const members = Array.from({ length: 101 }, (_, i) => {
    return {
      userId: `member-${i}`,
      role: i === 0 ? "admin" : "member",
    };
  });
  const offsets: number[] = [];
  server.use(
    http.get(
      `https://api.clerk.com/v1/organizations/${STAFF_ORG}/memberships`,
      ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        offsets.push(offset);
        return HttpResponse.json({
          total_count: members.length,
          data: members.slice(offset, offset + 100).map((member) => {
            return {
              role: `org:${member.role}`,
              public_user_data: { user_id: member.userId },
            };
          }),
        });
      },
    ),
  );
  await verifyLiveMembers(STAFF_ORG, members, "synthetic-clerk");
  assert.deepEqual(offsets, [0, 100]);
  await assert.rejects(
    verifyLiveMembers(STAFF_ORG, members.slice(1), "synthetic-clerk"),
    /LiveProductionMembershipChanged/u,
  );
  console.log(
    "Production operator CLI, encrypted artifacts, manual admission, capacity and live membership checks passed",
  );
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}

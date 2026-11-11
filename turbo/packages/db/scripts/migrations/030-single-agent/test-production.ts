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
  resolveProductionTarget,
  verifyLiveMembers,
} from "./production-guards";
import {
  BRANCH,
  BUCKET,
  ENDPOINT,
  PROJECT,
  STAFF_ORG,
  type ProductionContext,
  type ProductionMetadata,
} from "./production-model";
import {
  openBytes,
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

const baseContext: ProductionContext = {
  mode: "target",
  repository: "okou-ai/okou",
  ref: "refs/heads/main",
  commit: revision,
  driverCommit: revision,
  orgId: STAFF_ORG,
  runId: "200",
  runAttempt: 1,
  actor: "operator",
  writersDrained: false,
  planRunId: "100",
  planSha256: "a".repeat(64),
  imageSha256: "b".repeat(64),
  prefixesSha256: "c".repeat(64),
};
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
      "tsx",
      "--import",
      peer,
      file,
      ...args,
      "--peer-fixture",
      fixture,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,

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
async function request(
  context: ProductionContext,
  minimumCu = 8,
  sourceCommit = revision,
) {
  const root = join(directory, String(++counter));
  await mkdir(root, { mode: 0o700 });
  const contextFile = join(root, "context.json"),
    credentials = join(root, "credentials.json"),
    fixture = join(root, "peer.json");
  await writePrivate(contextFile, JSON.stringify(context));
  await writePrivate(
    credentials,
    JSON.stringify({
      neon: "synthetic-neon",
      github: "synthetic-github",
      clerk: "synthetic-clerk",
      key,
    }),
  );
  await writePrivate(
    fixture,
    JSON.stringify({ minimumCu, sourceCommit, planRunId: context.planRunId }),
  );
  return {
    root,
    fixture,
    args: ["--context", contextFile, "--credentials", credentials],
  };
}

try {
  const target = await request(baseContext);
  const output = join(target.root, "output");
  const result = await invoke(
    cli,
    [
      "--operation",
      "run",
      ...target.args,
      "--request",
      target.root,
      "--reviewed",
      join(target.root, "reviewed"),
      "--output",
      output,
    ],
    target.fixture,
  );
  assert.match(result.stdout, /"minimumCu":8/u);
  assert.deepEqual(await readdir(output), ["audit.json"]);
  assert.ok(
    !(await readFile(join(output, "audit.json"), "utf8")).includes(
      "synthetic-neon",
    ),
  );
  assert.deepEqual((await readdir(target.root)).sort(), [
    "context.json",
    "credentials.json",
    "output",
    "peer.json",
  ]);

  const tooSmall = await request(baseContext, 1);
  assert.match(
    (
      await invoke(
        cli,
        [
          "--operation",
          "run",
          ...tooSmall.args,
          "--request",
          tooSmall.root,
          "--reviewed",
          join(tooSmall.root, "reviewed"),
          "--output",
          join(tooSmall.root, "output"),
        ],
        tooSmall.fixture,
        false,
      )
    ).stderr,
    /ProductionRequiresProvisionedEightComputeUnits/u,
  );
  assert.ok(
    !(await readdir(tooSmall.root)).some((file) => {
      return file.startsWith("private-");
    }),
  );

  const apply = await request({
    ...baseContext,
    mode: "apply",
    writersDrained: true,
  });
  const githubOutput = join(apply.root, "github-output");
  await writePrivate(githubOutput, "");
  await invoke(
    cli,
    [
      "--operation",
      "verify-origin",
      ...apply.args,
      "--github-output",
      githubOutput,
    ],
    apply.fixture,
  );
  assert.equal(
    await readFile(githubOutput, "utf8"),
    `artifact-name=single-agent-plan-100\noperator-commit=${revision}\n`,
  );
  assert.equal(
    (await stat(join(apply.root, "bound-context.json"))).mode & 0o777,
    0o600,
  );

  const olderCommit = "d".repeat(40);
  const changedMain = await request(
    { ...baseContext, mode: "apply", writersDrained: true },
    8,
    olderCommit,
  );
  assert.match(
    (
      await invoke(
        cli,
        [
          "--operation",
          "verify-origin",
          ...changedMain.args,
          "--github-output",
          join(changedMain.root, "github-output"),
        ],
        changedMain.fixture,
        false,
      )
    ).stderr,
    /ProductionPlanOriginRejected/u,
  );
  const recovery = await request(
    { ...baseContext, mode: "recover", writersDrained: true },
    8,
    olderCommit,
  );
  const recoveryOutput = join(recovery.root, "github-output");
  await writePrivate(recoveryOutput, "");
  await invoke(
    cli,
    [
      "--operation",
      "verify-origin",
      ...recovery.args,
      "--github-output",
      recoveryOutput,
    ],
    recovery.fixture,
  );
  const bound = JSON.parse(
    await readFile(join(recovery.root, "bound-context.json"), "utf8"),
  );
  assert.equal(bound.commit, olderCommit);
  assert.equal(bound.driverCommit, revision);

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
      planRunId: "100",
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

  const prefixes = Buffer.from(
    JSON.stringify({
      format: "single-agent-prefixes-v1",
      orgId: STAFF_ORG,
      prefixes: [{ agentId: randomUUID(), prefix: "source" }],
    }),
  );
  const prefixesFile = join(directory, "prefixes.json"),
    sealedPrefixes = join(directory, "prefixes.base64");
  await writePrivate(prefixesFile, prefixes);
  const prefixResult = await invoke(
    packaging,
    [
      "seal-prefixes",
      "--input",
      prefixesFile,
      "--output",
      sealedPrefixes,
      "--key-file",
      keyFile,
    ],
    target.fixture,
  );
  assert.match(prefixResult.stdout, new RegExp(sha256(prefixes), "u"));
  assert.deepEqual(
    openBytes(
      Buffer.from((await readFile(sealedPrefixes, "utf8")).trim(), "base64"),
      packageKey(key),
      "single-agent-production-prefixes-v1",
    ),
    prefixes,
  );
  const prefixCiphertext = Buffer.from(
    (await readFile(sealedPrefixes, "utf8")).trim(),
    "base64",
  );
  assert.throws(() => {
    return openBytes(prefixCiphertext, packageKey(key), "other-scope");
  });

  const neon = `https://console.neon.tech/api/v2/projects/${PROJECT}`;
  server.use(
    http.get(`${neon}/branches/${BRANCH}`, () => {
      return HttpResponse.json({
        branch: {
          id: BRANCH,
          default: true,
          protected: true,
          current_state: "ready",
        },
      });
    }),
    http.get(`${neon}/endpoints`, () => {
      return HttpResponse.json({
        endpoints: [
          {
            id: "ep-fixture",
            host: "fixture.neon.tech",
            branch_id: BRANCH,
            type: "read_write",
            autoscaling_limit_min_cu: 8,
            autoscaling_limit_max_cu: 8,
          },
        ],
      });
    }),
    http.get(`${neon}/connection_uri`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      assert.equal(query.get("branch_id"), BRANCH);
      assert.equal(query.get("endpoint_id"), "ep-fixture");
      assert.equal(query.get("pooled"), "false");
      assert.equal(query.get("role_name"), "RO");
      return HttpResponse.json({
        uri: "postgresql://RO:synthetic@fixture.neon.tech/neondb?sslmode=require",
      });
    }),
  );
  const readOnlyTarget = await resolveProductionTarget(
    "plan",
    "synthetic-neon",
  );
  assert.equal(readOnlyTarget.role, "RO");
  assert.equal(
    new URL(readOnlyTarget.connection!).searchParams.get("sslmode"),
    "verify-full",
  );
  server.use(
    http.get(`${neon}/connection_uri`, () => {
      return HttpResponse.json({
        uri: "postgresql://RO:synthetic@another.neon.tech/neondb",
      });
    }),
  );
  await assert.rejects(
    resolveProductionTarget("plan", "synthetic-neon"),
    /ProductionConnectionIdentityRejected/u,
  );

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
    "Production operator CLI, encrypted artifacts, origin binding, capacity and live membership checks passed",
  );
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  SKILL_IMPORT_SESSION_TTL_SECONDS,
  skillImportSessionsContract,
  skillImportSkillsContract,
} from "@okouai/api-contracts/contracts/skill-import";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { skillImportRoutes } from "../skill-import";
import { workflowsRoutes } from "../workflows";
import { createRouteMocks } from "./helpers/route-test";
import { clearMockNow, mockNow, now } from "../../../lib/time";

const context = testContext();

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function newMember(orgId = `org_${randomUUID()}`): Member {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signedIn(member: Member) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    "org:member",
  );
  return { authorization: "Bearer clerk-session" };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function sessions() {
  return setupApp({ context, routes: skillImportRoutes })(
    skillImportSessionsContract,
  );
}

function skills() {
  return setupApp({ context, routes: skillImportRoutes })(
    skillImportSkillsContract,
  );
}

function workflowCollection() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function workflowDetail() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

interface StoredObject {
  readonly body: Buffer;
}

/** In-memory object storage standing in for the external S3/R2 boundary. */
function useObjectStorage(options: { readonly failWrites?: boolean } = {}) {
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const id = (input: Record<string, unknown>) => {
    return `${String(input.Bucket)}/${String(input.Key)}`;
  };
  const storageError = () => {
    return Promise.reject(
      Object.assign(new Error("Storage unavailable"), {
        name: "InternalError",
        $metadata: { httpStatusCode: 500 },
      }),
    );
  };
  const notFound = () => {
    return Promise.reject(
      Object.assign(new Error("Not found"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      }),
    );
  };
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    const stored = objects.get(id(input));
    switch (constructor.name) {
      case "PutObjectCommand": {
        if (options.failWrites) {
          return storageError();
        }
        objects.set(id(input), {
          body: Buffer.from(input.Body as string | Uint8Array),
        });
        return Promise.resolve({ ETag: '"put"' });
      }
      case "HeadObjectCommand": {
        if (!stored) {
          return notFound();
        }
        return Promise.resolve({ ContentLength: stored.body.byteLength });
      }
      case "GetObjectCommand": {
        if (!stored) {
          return Promise.reject(
            Object.assign(new Error("Missing"), {
              name: "NoSuchKey",
              $metadata: { httpStatusCode: 404 },
            }),
          );
        }
        return Promise.resolve({
          Body: Readable.from([stored.body]),
          ContentLength: stored.body.byteLength,
        });
      }
      case "CreateMultipartUploadCommand": {
        if (options.failWrites) {
          return storageError();
        }
        const uploadId = randomUUID();
        uploads.set(uploadId, new Map());
        return Promise.resolve({ UploadId: uploadId });
      }
      case "UploadPartCommand": {
        if (options.failWrites) {
          return storageError();
        }
        uploads
          .get(String(input.UploadId))
          ?.set(
            Number(input.PartNumber),
            Buffer.from(input.Body as string | Uint8Array),
          );
        return Promise.resolve({ ETag: `"part-${String(input.PartNumber)}"` });
      }
      case "CompleteMultipartUploadCommand": {
        if (options.failWrites) {
          return storageError();
        }
        const parts = uploads.get(String(input.UploadId)) ?? new Map();
        const body = Buffer.concat(
          [...parts.entries()]
            .sort(([left], [right]) => {
              return left - right;
            })
            .map(([, part]) => {
              return part;
            }),
        );
        objects.set(id(input), { body });
        return Promise.resolve({ ETag: '"complete"' });
      }
      default: {
        return Promise.resolve({});
      }
    }
  });
}

async function openSession(
  member: Member,
  provider: "claudeCode" | "codex" = "claudeCode",
) {
  const response = await accept(
    sessions().create({ headers: signedIn(member), body: { provider } }),
    [200],
  );
  return response.body;
}

function skill(name: string, instruction = `Use ${name} carefully.`) {
  return { name, instruction };
}

async function uploadCreated(
  token: string,
  body: Parameters<ReturnType<typeof skills>["upload"]>[0]["body"],
) {
  const response = await accept(
    skills().upload({ headers: bearer(token), body }),
    [201],
  );
  return response.body;
}

async function listSessionSkills(member: Member, sessionId: string) {
  const response = await accept(
    sessions().listSkills({
      headers: signedIn(member),
      params: { sessionId },
    }),
    [200],
  );
  return response.body;
}

async function readWorkflow(member: Member, workflowId: string) {
  const response = await accept(
    workflowDetail().get({
      headers: signedIn(member),
      params: { workflowId },
    }),
    [200],
  );
  return response.body;
}

async function listWorkflows(member: Member) {
  const response = await accept(
    workflowCollection().list({ headers: signedIn(member), query: {} }),
    [200],
  );
  return response.body;
}

function fileContents(
  workflow: Awaited<ReturnType<typeof readWorkflow>>,
): Record<string, string> {
  return Object.fromEntries(
    (workflow.fileContents ?? []).map((file) => {
      return [file.path, file.content];
    }),
  );
}

describe("POST /api/skill-import/sessions", () => {
  it("skill-import.bdd-001 keeps parallel sessions and late uploads attributed to their own sessions", async () => {
    useObjectStorage();
    const member = newMember();
    const first = await openSession(member, "claudeCode");
    const second = await openSession(member, "codex");

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.token).not.toBe(first.token);

    const fresh = await uploadCreated(second.token, skill("new-session-skill"));
    const late = await uploadCreated(
      first.token,
      skill("late-old-session-skill"),
    );

    const firstList = await listSessionSkills(member, first.sessionId);
    const secondList = await listSessionSkills(member, second.sessionId);
    expect(
      firstList.map((workflow) => {
        return [workflow.id, workflow.name];
      }),
    ).toStrictEqual([[late.workflowId, "late-old-session-skill"]]);
    expect(
      secondList.map((workflow) => {
        return [workflow.id, workflow.name];
      }),
    ).toStrictEqual([[fresh.workflowId, "new-session-skill"]]);
  });

  it("skill-import.bdd-002 does not expose another member or workspace's import results", async () => {
    useObjectStorage();
    const member = newMember();
    const colleague = newMember(member.orgId);
    const outsider = newMember();
    const session = await openSession(member);
    await uploadCreated(session.token, skill("private-skill"));

    await expect(
      listSessionSkills(colleague, session.sessionId),
    ).resolves.toStrictEqual([]);
    await expect(
      listSessionSkills(outsider, session.sessionId),
    ).resolves.toStrictEqual([]);

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return null;
      },
    });
    const tokenOnly = await sessions().listSkills({
      headers: bearer(session.token),
      params: { sessionId: session.sessionId },
    });
    expect(tokenOnly.status).toBe(401);
  });

  it("skill-import.bdd-003 issues an upload session for the workspace member", async () => {
    const member = newMember();
    const before = now();
    const session = await openSession(member);

    expect(session.uploadUrl).toBe(
      "http://localhost:3000/api/skill-import/skills",
    );
    expect(session.token).toMatch(/^vm0_skillimport_/);
    expect(session.limits).toStrictEqual({
      maxSkillsPerSession: 50,
      maxInstructionBytes: 256 * 1024,
      maxFilesPerSkill: 50,
      maxFileBytes: 64 * 1024,
      maxTotalFileBytes: 1024 * 1024,
      maxRequestBytes: 2 * 1024 * 1024,
    });
    const remaining = Date.parse(session.expiresAt) - before;
    expect(remaining).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe("POST /api/skill-import/skills", () => {
  it("skill-import.bdd-005 imports a skill as a private workflow for the workspace member", async () => {
    useObjectStorage();
    const member = newMember();
    const session = await openSession(member);

    const created = await uploadCreated(session.token, {
      name: "Release Notes",
      displayName: "Release Notes",
      description: "Drafts release notes",
      instruction: "Write the release notes.",
      files: [
        { path: "./references//tone.md", content: "Keep it short. 世界" },
        { path: "references//tone.md", content: "Keep it short. 世界" },
        { path: "references/tone.md", content: "Keep it short. 世界" },
      ],
    });
    expect(created.outcome).toBe("created");
    expect(created.name).toBe("release-notes");

    const workflow = await readWorkflow(member, created.workflowId);
    expect(workflow).toMatchObject({
      id: created.workflowId,
      name: "release-notes",
      visibility: "private",
      ownerUserId: member.userId,
      displayName: "Release Notes",
      description: "Drafts release notes",
      instruction: "Write the release notes.",
    });
    expect(fileContents(workflow)).toStrictEqual({
      "references/tone.md": "Keep it short. 世界",
    });

    const listed = (await listWorkflows(member)).find((entry) => {
      return entry.id === created.workflowId;
    });
    expect(listed).toMatchObject({
      name: "release-notes",
      visibility: "private",
    });
  });

  it("skill-import.bdd-006 tags the workflow with the tool the session was opened for", async () => {
    useObjectStorage();
    const member = newMember();
    const session = await openSession(member, "codex");
    const created = await uploadCreated(session.token, skill("codex-skill"));

    const listed = (await listWorkflows(member)).find((entry) => {
      return entry.id === created.workflowId;
    });
    expect(listed?.importSource).toBe("codex");
  });

  it("skill-import.bdd-007 skips a skill whose name is already imported", async () => {
    useObjectStorage();
    const member = newMember();
    const session = await openSession(member);
    const created = await uploadCreated(session.token, skill("release-notes"));

    const again = await accept(
      skills().upload({
        headers: bearer(session.token),
        body: skill("release-notes", "A different instruction."),
      }),
      [200],
    );
    expect(again.body).toStrictEqual({
      outcome: "skipped",
      reason: "name_exists",
      workflowId: created.workflowId,
      name: "release-notes",
    });
  });

  it("skill-import.bdd-008 reports a name taken by a built-in workflow", async () => {
    useObjectStorage();
    const session = await openSession(newMember());

    const response = await accept(
      skills().upload({
        headers: bearer(session.token),
        body: skill("workflow-setup"),
      }),
      [409],
    );
    expect(response.body.error.code).toBe("SKILL_NAME_TAKEN");
  });

  it("skill-import.bdd-010 rejects an instruction over the instruction limit", async () => {
    useObjectStorage();
    const session = await openSession(newMember());

    const response = await accept(
      skills().upload({
        headers: bearer(session.token),
        body: skill("huge-skill", "a".repeat(256 * 1024 + 1)),
      }),
      [413],
    );
    expect(response.body.error.code).toBe("SKILL_TOO_LARGE");
  });

  it("skill-import.bdd-013 repairs relative Windows paths and preserves the attachment text", async () => {
    useObjectStorage();
    const member = newMember();
    const session = await openSession(member);

    const created = await uploadCreated(session.token, {
      name: "release-notes",
      instruction: "Write the release notes.",
      files: [
        { path: "references\\tone.md", content: "Keep it short. 世界" },
        { path: ".\\scripts\\\\check.sh", content: "echo ok\n" },
      ],
    });
    expect(created.outcome).toBe("created");
    expect(created.name).toBe("release-notes");

    const workflow = await readWorkflow(member, created.workflowId);
    expect(fileContents(workflow)).toStrictEqual({
      "references/tone.md": "Keep it short. 世界",
      "scripts/check.sh": "echo ok\n",
    });
  });

  it("skill-import.bdd-014 imports the instruction and valid files while reporting unusable attachments", async () => {
    useObjectStorage();
    const member = newMember();
    const session = await openSession(member);
    const longName = `${"n".repeat(252)}.md`;
    const invalidPaths = [
      "/etc/passwd",
      "/references/tone.md",
      String.raw`C:\skills\tone.md`,
      "C:tone.md",
      "D:/skills/tone.md",
      String.raw`\\server\share\tone.md`,
      "//server/share/tone.md",
      String.raw`\rooted.md`,
      "../escape.md",
      "references/../../escape.md",
      String.raw`..\escape.md`,
      "SKILL.md",
      "./SKILL.md",
      "SKILL.md/notes.md",
      "",
      ".",
      "references/",
      "references",
      `${"x".repeat(256)}.md`,
    ];
    const invalidFiles = invalidPaths.map((path) => {
      return { path, content: "ignored" };
    });

    const created = await uploadCreated(session.token, {
      name: "release-notes",
      instruction: "Write the release notes.",
      files: [
        { path: "references/tone.md", content: "Keep it short. 世界" },
        { path: "scripts/check.sh", content: "echo ok\n" },
        { path: longName, content: "long name" },
        ...invalidFiles,
        { path: "data.txt", content: "a\u0000b" },
        { path: "large.txt", content: "z".repeat(64 * 1024 + 1) },
      ],
    });

    expect(created.skippedFiles).toStrictEqual([
      ...invalidPaths.map((path) => {
        return { path, reason: "invalid_path" };
      }),
      { path: "data.txt", reason: "binary_content" },
      { path: "large.txt", reason: "size_limit" },
    ]);
    const workflow = await readWorkflow(member, created.workflowId);
    expect(workflow.instruction).toBe("Write the release notes.");
    expect(fileContents(workflow)).toStrictEqual({
      "references/tone.md": "Keep it short. 世界",
      "scripts/check.sh": "echo ok\n",
      [longName]: "long name",
    });
  });

  it("skill-import.bdd-018 keeps accepted files when the file count limit is reached", async () => {
    useObjectStorage();
    const member = newMember();
    const session = await openSession(member);

    const created = await uploadCreated(session.token, {
      name: "many-files",
      instruction: "Use the files.",
      files: Array.from({ length: 51 }, (_, index) => {
        return { path: `file-${String(index)}.txt`, content: `file ${index}` };
      }),
    });

    expect(created.skippedFiles).toStrictEqual([
      { path: "file-50.txt", reason: "size_limit" },
    ]);
    const workflow = await readWorkflow(member, created.workflowId);
    expect(workflow.fileContents).toHaveLength(50);
  });

  it("skill-import.bdd-024 does not report success after a storage write failure", async () => {
    useObjectStorage({ failWrites: true });
    const member = newMember();
    const session = await openSession(member);

    // The contract has no 500 response, so the typed client cannot express it.
    const request = setupRawAppRequest({ context, routes: skillImportRoutes });
    const response = await request(skillImportSkillsContract.upload.path, {
      method: "POST",
      headers: {
        ...bearer(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "release-notes",
        instruction: "Write the release notes.",
        files: [{ path: "references/tone.md", content: "Keep it short." }],
      }),
    });
    expect(response.status).toBe(500);
    await expect(
      listSessionSkills(member, session.sessionId),
    ).resolves.toStrictEqual([]);
  });

  it("skill-import.bdd-026 rejects an expired session token", async () => {
    useObjectStorage();
    const issuedAt = now();
    mockNow(issuedAt);
    const session = await openSession(newMember());
    mockNow(issuedAt + (SKILL_IMPORT_SESSION_TTL_SECONDS + 60) * 1000);

    const response = await accept(
      skills().upload({
        headers: bearer(session.token),
        body: skill("expired-skill"),
      }),
      [401],
    );
    clearMockNow();
    expect(response.body.error.code).toBe("SKILL_IMPORT_SESSION_INVALID");
  });

  it("skill-import.bdd-028 does not authenticate any other route", async () => {
    const session = await openSession(newMember());
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return null;
      },
    });

    const response = await accept(
      workflowCollection().list({ headers: bearer(session.token), query: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});

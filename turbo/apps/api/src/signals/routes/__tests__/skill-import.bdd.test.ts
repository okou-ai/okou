import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SKILL_IMPORT_LIMITS,
  skillImportSessionsContract,
  skillImportSkillsContract,
  type SkillImportRequest,
  type SkillImportSessionRequest,
  type SkillImportSessionResponse,
} from "@okouai/api-contracts/contracts/skill-import";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { nowDate, now } from "../../../lib/time";
import { signSkillImportJwtForTests } from "../../auth/tokens";
import { skillImportRoutes } from "../skill-import";
import { workflowsRoutes } from "../workflows";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);

type OrgActor = ApiTestUser & { readonly orgId: string };

/**
 * Object-store boundary for skill volumes, so an imported skill can be read
 * back through the workflow detail endpoint.
 */
function installVolumeStorage(): void {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const { Key: key, Body: body } = command.input;
      if (!key || !(typeof body === "string" || body instanceof Uint8Array)) {
        throw new Error("Expected a volume object body and key");
      }
      objects.set(key, Buffer.from(body));
      return Promise.resolve({});
    }
    if (
      command instanceof HeadObjectCommand ||
      command instanceof GetObjectCommand
    ) {
      const key = command.input.Key;
      const body = key ? objects.get(key) : undefined;
      if (!body) {
        throw Object.assign(new Error("Object not found"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return Promise.resolve({
        ContentLength: body.length,
        Body: Readable.from([body]),
      });
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return Promise.resolve({
        Contents: [...objects]
          .filter(([key]) => {
            return key.startsWith(prefix);
          })
          .map(([Key, body]) => {
            return { Key, Size: body.length, LastModified: nowDate() };
          }),
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key) {
          objects.delete(object.Key);
        }
      }
    }
    return Promise.resolve({});
  });
}

function clerkHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function sessionsClient() {
  return setupApp({ context, routes: skillImportRoutes })(
    skillImportSessionsContract,
  );
}

function uploadClient() {
  return setupApp({ context, routes: skillImportRoutes })(
    skillImportSkillsContract,
  );
}

function workflowListClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function workflowDetailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function tokenHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function skillBody(
  overrides: Partial<SkillImportRequest> = {},
): SkillImportRequest {
  return {
    name: "release-notes",
    displayName: "Release Notes",
    description: "Draft release notes from merged pull requests",
    instruction: "Collect the merged pull requests and draft release notes.",
    ...overrides,
  };
}

/**
 * The import rolls out with the onboarding step and the workflows page dialog
 * it serves, so every case that exercises the service enables one of their
 * switches for its own user first.
 */
async function setSkillImportSwitch(
  actor: OrgActor,
  enabled: boolean,
  key:
    | FeatureSwitchKey.OnboardingSourcesFirst
    | FeatureSwitchKey.WorkflowSkillImport = FeatureSwitchKey.OnboardingSourcesFirst,
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: actor.orgRole },
    { [key]: enabled },
  );
}

async function bootstrapActor(): Promise<{
  readonly actor: OrgActor;
  readonly agentId: string;
}> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected the test actor to have an organization");
  }
  bdd.acceptAgentStorageWrites();
  installVolumeStorage();
  const status = await bdd.readOnboardingStatus(actor);
  if (!status.defaultAgentId) {
    throw new Error("Expected onboarding to bootstrap a default agent");
  }
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: status.defaultAgentId,
  };
}

async function openSession(body: SkillImportSessionRequest = {}): Promise<{
  readonly actor: OrgActor;
  readonly agentId: string;
  readonly session: SkillImportSessionResponse;
}> {
  const { actor, agentId } = await bootstrapActor();
  await setSkillImportSwitch(actor, true);

  const response = await accept(
    sessionsClient().create({ headers: clerkHeaders(actor), body }),
    [200],
  );

  return { actor, agentId, session: response.body };
}

describe("POST /api/skill-import/sessions", () => {
  it("issues an upload session for the org's default agent", async () => {
    const { session } = await openSession();

    expect(session.uploadUrl).toBe(
      "http://localhost:3000/api/skill-import/skills",
    );
    expect(session.token.startsWith("vm0_skillimport_")).toBeTruthy();
    expect(session.limits).toStrictEqual(SKILL_IMPORT_LIMITS);
    const remainingMs = Date.parse(session.expiresAt) - now();
    expect(remainingMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(remainingMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("refuses a caller whose onboarding and workflow import switches are off", async () => {
    const { actor } = await bootstrapActor();

    const response = await accept(
      sessionsClient().create({ headers: clerkHeaders(actor), body: {} }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("serves a caller who only has the workflow import switch", async () => {
    const { actor, agentId } = await bootstrapActor();
    await setSkillImportSwitch(
      actor,
      true,
      FeatureSwitchKey.WorkflowSkillImport,
    );

    const session = await accept(
      sessionsClient().create({
        headers: clerkHeaders(actor),
        body: { provider: "claudeCode" },
      }),
      [200],
    );
    const created = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.body.token),
        body: skillBody(),
      }),
      [201],
    );

    const listed = await accept(
      workflowListClient().list({
        headers: clerkHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(listed.body).toContainEqual(
      expect.objectContaining({ id: created.body.workflowId }),
    );
  });

  it("rejects a tool the import does not write prompts for", async () => {
    const { actor } = await bootstrapActor();
    await setSkillImportSwitch(actor, true);
    const request = setupRawAppRequest({ context, routes: skillImportRoutes });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const response = await request("/api/skill-import/sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "cursor" }),
    });

    expect(response.status).toBe(400);
    expectApiError(response.body);
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("refuses an unauthenticated caller", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await accept(
      sessionsClient().create({
        headers: { authorization: "Bearer nope" },
        body: {},
      }),
      [401],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/skill-import/skills", () => {
  it("imports a skill as a private workflow on the session's agent", async () => {
    const { actor, agentId, session } = await openSession();

    const created = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody({
          name: "Release Notes",
          files: [
            { path: "references/tone.md", content: "Keep it short. 世界" },
          ],
        }),
      }),
      [201],
    );

    expect(created.body).toStrictEqual({
      outcome: "created",
      workflowId: expect.any(String),
      // The locally authored name is normalized into a workflow slug.
      name: "release-notes",
    });

    const detail = await accept(
      workflowDetailClient().get({
        headers: clerkHeaders(actor),
        params: { workflowId: created.body.workflowId },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      agentId,
      name: "release-notes",
      displayName: "Release Notes",
      description: "Draft release notes from merged pull requests",
      visibility: "private",
      ownerUserId: actor.userId,
      instruction: "Collect the merged pull requests and draft release notes.",
    });
    expect(detail.body.fileContents).toStrictEqual([
      { path: "references/tone.md", content: "Keep it short. 世界" },
    ]);

    const listed = await accept(
      workflowListClient().list({
        headers: clerkHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(listed.body).toContainEqual(
      expect.objectContaining({
        id: created.body.workflowId,
        name: "release-notes",
        visibility: "private",
      }),
    );
  });

  it("tags the workflow with the tool the session was opened for", async () => {
    const { actor, agentId, session } = await openSession({
      provider: "codex",
    });

    const created = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody(),
      }),
      [201],
    );

    const listed = await accept(
      workflowListClient().list({
        headers: clerkHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(listed.body).toContainEqual(
      expect.objectContaining({
        id: created.body.workflowId,
        importSource: "codex",
      }),
    );
  });

  it("leaves the workflow untagged for a session that named no tool", async () => {
    const { actor, agentId } = await openSession();
    // A token minted before sessions recorded a tool carries no provider.
    const issuedAt = Math.floor(now() / 1000);
    const untagged = signSkillImportJwtForTests({
      scope: "skill-import",
      userId: actor.userId,
      orgId: actor.orgId,
      agentId,
      iat: issuedAt,
      exp: issuedAt + 60 * 60,
    });

    const created = await accept(
      uploadClient().upload({
        headers: tokenHeaders(untagged),
        body: skillBody(),
      }),
      [201],
    );

    const listed = await accept(
      workflowListClient().list({
        headers: clerkHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(listed.body).toContainEqual(
      expect.objectContaining({
        id: created.body.workflowId,
        importSource: null,
      }),
    );
  });

  it("skips a skill whose name is already imported", async () => {
    const { session } = await openSession();
    const created = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody(),
      }),
      [201],
    );

    const repeated = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody({ instruction: "A different instruction." }),
      }),
      [200],
    );

    expect(repeated.body).toStrictEqual({
      outcome: "skipped",
      reason: "name_exists",
      workflowId: created.body.workflowId,
      name: "release-notes",
    });
  });

  it("reports a name taken by a built-in workflow", async () => {
    const { session } = await openSession();

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody({ name: "workflow-setup" }),
      }),
      [409],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("SKILL_NAME_TAKEN");
  });

  it("rejects a request body over the size limit", async () => {
    const { session } = await openSession();

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody({
          instruction: "a".repeat(SKILL_IMPORT_LIMITS.maxRequestBytes + 1),
        }),
      }),
      [413],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("SKILL_TOO_LARGE");
  });

  it("rejects an instruction over the instruction limit", async () => {
    const { session } = await openSession();

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody({
          instruction: "a".repeat(SKILL_IMPORT_LIMITS.maxInstructionBytes + 1),
        }),
      }),
      [413],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("SKILL_TOO_LARGE");
  });

  it("rejects content that is not valid UTF-8", async () => {
    const { session } = await openSession();
    const request = setupRawAppRequest({ context, routes: skillImportRoutes });

    const response = await request("/api/skill-import/skills", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: Buffer.concat([
        Buffer.from('{"name":"binary-skill","instruction":"'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}'),
      ]),
    });

    expect(response.status).toBe(400);
    expectApiError(response.body);
    expect(response.body.error.code).toBe("BINARY_FILE_UNSUPPORTED");
  });

  it("stops an open session once the switch is turned off", async () => {
    const { actor, session } = await openSession();
    await setSkillImportSwitch(actor, false);

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody(),
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects metadata that carries binary content", async () => {
    const { session } = await openSession();

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody({ description: "drafts\u0000notes" }),
      }),
      [400],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("BINARY_FILE_UNSUPPORTED");
  });

  it("rejects a file that carries binary content", async () => {
    const { session } = await openSession();

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody({
          files: [{ path: "data.txt", content: "text\u0000more" }],
        }),
      }),
      [400],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("BINARY_FILE_UNSUPPORTED");
  });

  it("rejects an upload that carries the reserved SKILL.md path", async () => {
    const { session } = await openSession();

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody({
          files: [{ path: "SKILL.md", content: "---\nname: x\n---\n" }],
        }),
      }),
      [400],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects an expired session token", async () => {
    const { actor, agentId } = await openSession();
    const issuedAt = Math.floor(now() / 1000) - 2 * 60 * 60;
    const expired = signSkillImportJwtForTests({
      scope: "skill-import",
      userId: actor.userId,
      orgId: actor.orgId,
      agentId,
      iat: issuedAt,
      exp: issuedAt + 60 * 60,
    });

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(expired),
        body: skillBody(),
      }),
      [401],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("SKILL_IMPORT_SESSION_INVALID");
  });

  it("rejects a token that does not verify", async () => {
    const { session } = await openSession();

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(`${session.token}tampered`),
        body: skillBody(),
      }),
      [401],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("SKILL_IMPORT_SESSION_INVALID");
  });

  it("rejects a session pointed at an agent the caller cannot reach", async () => {
    const { actor } = await openSession();
    const issuedAt = Math.floor(now() / 1000);
    const elsewhere = signSkillImportJwtForTests({
      scope: "skill-import",
      userId: actor.userId,
      orgId: actor.orgId,
      agentId: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + 60 * 60,
    });

    const response = await accept(
      uploadClient().upload({
        headers: tokenHeaders(elsewhere),
        body: skillBody(),
      }),
      [401],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("SKILL_IMPORT_SESSION_INVALID");
  });

  it("does not authenticate any other route", async () => {
    const { agentId, session } = await openSession();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await accept(
      workflowListClient().list({
        headers: tokenHeaders(session.token),
        query: { agentId },
      }),
      [401],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it(
    "stops importing once the session cap is reached",
    { timeout: 120_000 },
    async () => {
      const { session } = await openSession();

      for (
        let index = 0;
        index < SKILL_IMPORT_LIMITS.maxSkillsPerSession;
        index++
      ) {
        await accept(
          uploadClient().upload({
            headers: tokenHeaders(session.token),
            body: skillBody({ name: `capped-skill-${String(index)}` }),
          }),
          [201],
        );
      }

      const response = await accept(
        uploadClient().upload({
          headers: tokenHeaders(session.token),
          body: skillBody({ name: "capped-skill-overflow" }),
        }),
        [429],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("SKILL_IMPORT_LIMIT_REACHED");
    },
  );
});

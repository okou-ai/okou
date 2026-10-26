import { randomUUID } from "node:crypto";

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

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSkillImportJwtForTests } from "../../auth/tokens";
import { skillImportRoutes } from "../skill-import";
import { workflowsRoutes } from "../workflows";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);

type OrgActor = ApiTestUser & { readonly orgId: string };

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

async function bootstrapActor(): Promise<{
  readonly actor: OrgActor;
  readonly agentId: string;
}> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected the test actor to have an organization");
  }
  bdd.acceptAgentStorageWrites();
  installWorkflowVolumeS3Fixture(context);
  const status = await bdd.readOnboardingStatus(actor);
  if (!status.defaultAgentId) {
    throw new Error("Expected onboarding to bootstrap a default agent");
  }
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: status.defaultAgentId,
  };
}

async function openSession(
  body: SkillImportSessionRequest = { provider: "claudeCode" },
): Promise<{
  readonly actor: OrgActor;
  readonly agentId: string;
  readonly session: SkillImportSessionResponse;
}> {
  const { actor, agentId } = await bootstrapActor();

  const response = await accept(
    sessionsClient().create({ headers: clerkHeaders(actor), body }),
    [200],
  );

  return { actor, agentId, session: response.body };
}

describe("POST /api/skill-import/sessions", () => {
  it("keeps parallel sessions and late uploads attributed to their own credentials", async () => {
    const { actor, session: first } = await openSession();
    const second = await accept(
      sessionsClient().create({
        headers: clerkHeaders(actor),
        body: { provider: "codex" },
      }),
      [200],
    );
    expect(first.sessionId).toBeDefined();
    expect(second.body.sessionId).toBeDefined();
    expect(first.sessionId).not.toBe(second.body.sessionId);
    expect(first.token).not.toBe(second.body.token);
    const secondUpload = await accept(
      uploadClient().upload({
        headers: tokenHeaders(second.body.token),
        body: skillBody({ name: "new-session-skill" }),
      }),
      [201],
    );
    // The prompt copied earlier is still valid after another session opens.
    const firstUpload = await accept(
      uploadClient().upload({
        headers: tokenHeaders(first.token),
        body: skillBody({ name: "late-old-session-skill" }),
      }),
      [201],
    );
    for (const [session, uploaded] of [
      [first, firstUpload],
      [second.body, secondUpload],
    ] as const) {
      if (!session.sessionId) {
        throw new Error("Expected an attributed session");
      }
      const result = await accept(
        sessionsClient().listSkills({
          headers: clerkHeaders(actor),
          params: { sessionId: session.sessionId },
        }),
        [200],
      );
      expect(
        result.body.map((skill) => {
          return skill.id;
        }),
      ).toStrictEqual([uploaded.body.workflowId]);
    }
  });

  it("does not expose another member or organization's import results", async () => {
    const { actor, session } = await openSession();
    if (!session.sessionId) {
      throw new Error("Expected an attributed session");
    }
    await accept(
      uploadClient().upload({
        headers: tokenHeaders(session.token),
        body: skillBody(),
      }),
      [201],
    );
    for (const other of [bdd.user({ orgId: actor.orgId }), bdd.user()]) {
      const result = await accept(
        sessionsClient().listSkills({
          headers: clerkHeaders(other),
          params: { sessionId: session.sessionId },
        }),
        [200],
      );
      expect(result.body).toStrictEqual([]);
    }
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return { userId: null, orgId: null };
      },
    });
    await accept(
      sessionsClient().listSkills({
        headers: tokenHeaders(session.token),
        params: { sessionId: session.sessionId },
      }),
      [401],
    );
  });

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

  it("refuses an unauthenticated caller", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await accept(
      sessionsClient().create({
        headers: { authorization: "Bearer nope" },
        body: { provider: "claudeCode" },
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
      provider: "claudeCode",
      sessionId: randomUUID(),
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
      provider: "claudeCode",
      sessionId: randomUUID(),
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
      const { actor, agentId, session } = await openSession();
      // Workflows created outside this credential cannot consume its quota.
      await accept(
        workflowListClient().create({
          headers: clerkHeaders(actor),
          body: {
            agentId,
            name: "unrelated-private-skill",
            instruction: "Unrelated work",
          },
        }),
        [201],
      );

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
      const next = await accept(
        sessionsClient().create({
          headers: clerkHeaders(actor),
          body: { provider: "claudeCode" },
        }),
        [200],
      );
      await accept(
        uploadClient().upload({
          headers: tokenHeaders(next.body.token),
          body: skillBody({ name: "independent-session-skill" }),
        }),
        [201],
      );
    },
  );
});

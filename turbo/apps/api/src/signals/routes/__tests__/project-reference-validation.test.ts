import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { projectRoutes } from "../projects";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const fixture = createChatEventsFixture(context);

function projects() {
  return setupApp({ context, routes: projectRoutes })(projectsContract);
}

async function enableProjects(actor: ApiTestUser, enabled = true) {
  if (!actor.orgId) {
    throw new Error("Expected an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.Projects]: enabled },
  );
}

async function createProject(actor: ApiTestUser, name: string) {
  const id = createProjectOperationId(now(), randomUUID());
  return (
    await accept(
      projects().create({
        headers: fixture.sessionHeaders(actor),
        body: { id, eventId: id, name },
      }),
      [201],
    )
  ).body;
}

function mention(projectId: string, nameSnapshot = "Captured project") {
  return { type: "project" as const, projectId, nameSnapshot };
}

describe("project reference admission through chat send", () => {
  it("keeps sends without references available while Projects is disabled", async () => {
    const { actor, agentId } = await fixture.entitledNativeChatActor();
    await enableProjects(actor, false);
    const run = await fixture.sendChatRun(actor, {
      agentId,
      prompt: "No project references",
    });
    expect((await fixture.api.readRun(actor, run.runId)).prompt).toBe(
      "No project references",
    );
    await fixture.cancelChatRun(actor, run.runId);
  });

  it("preserves multiple, repeated and mixed-case references in ordinary parts and feedback notes", async () => {
    const { actor, agentId } = await fixture.entitledNativeChatActor();
    await enableProjects(actor);
    const first = await createProject(actor, "Research");
    const second = await createProject(actor, "Launch");
    const document: UserMessageInputDocument = {
      version: 1,
      parts: [
        { type: "text", text: "Compare " },
        mention(second.id, "Captured launch"),
        mention(first.id.toUpperCase(), "Uppercase research"),
        mention(second.id, "Repeated launch"),
        {
          type: "feedback",
          quote: "Review the dependencies",
          note: [
            mention(first.id, "Research note"),
            { type: "text", text: " then " },
            mention(second.id.toUpperCase(), "Launch note"),
          ],
        },
      ],
    };
    const eventId = randomUUID();
    const run = await fixture.sendChatRun(actor, {
      agentId,
      clientEventId: eventId,
      prompt: "Compare projects",
      userMessage: document,
    });
    const events = await fixture.chat.listThreadEvents(actor, run.threadId);
    expect(
      events.events.find((event) => {
        return event.id === eventId;
      }),
    ).toMatchObject({ eventType: "input.prompt", userMessage: document });
    const prepared = await fixture.api.readRun(actor, run.runId);
    expect(prepared.prompt).toContain(
      `[Captured launch](/projects/${second.id})[Uppercase research](/projects/${first.id.toUpperCase()})[Repeated launch](/projects/${second.id})`,
    );
    expect(prepared.prompt).toContain(
      `[Research note](/projects/${first.id}) then [Launch note](/projects/${second.id.toUpperCase()})`,
    );
    await fixture.cancelChatRun(actor, run.runId);
  });

  it.each(["ordinary", "feedback"] as const)(
    "rejects a mixed valid/missing batch from %s without publishing an input",
    async (location) => {
      const { actor, agentId } = await fixture.entitledNativeChatActor();
      await enableProjects(actor);
      const project = await createProject(actor, "Available");
      const thread = await fixture.chat.createThread(actor, { agentId });
      const before = await fixture.chat.listThreadEvents(actor, thread.id);
      const references = [mention(project.id), mention(randomUUID())];
      const result = await fixture.chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "Unavailable project",
          userMessage: {
            version: 1,
            parts:
              location === "ordinary"
                ? references
                : [{ type: "feedback", quote: "Review", note: references }],
          },
        },
        [404],
      );
      expect(result.body).toMatchObject({
        error: {
          code: "NOT_FOUND",
          message: "Project or conversation not found",
        },
      });
      expect(
        (await fixture.chat.listThreadEvents(actor, thread.id)).events,
      ).toStrictEqual(before.events);
    },
  );

  it.each(["user", "organization"] as const)(
    "rejects a batch containing a foreign %s project without leaking its existence",
    async (boundary) => {
      const { actor, agentId } = await fixture.entitledNativeChatActor();
      await enableProjects(actor);
      const own = await createProject(actor, "Own");
      const foreign = fixture.bdd.user(
        boundary === "user" ? { orgId: actor.orgId } : { userId: actor.userId },
      );
      await enableProjects(foreign);
      const other = await createProject(foreign, "Private elsewhere");
      const result = await fixture.chat.requestSendEvent(
        actor,
        {
          agentId,
          prompt: "Cannot use a foreign project",
          userMessage: {
            version: 1,
            parts: [mention(own.id), mention(other.id)],
          },
        },
        [404],
      );
      expect(result.body).toMatchObject({
        error: {
          code: "NOT_FOUND",
          message: "Project or conversation not found",
        },
      });
    },
  );

  it("rejects references after Projects is disabled without publishing an input", async () => {
    const { actor, agentId } = await fixture.entitledNativeChatActor();
    await enableProjects(actor);
    const project = await createProject(actor, "Existing");
    const thread = await fixture.chat.createThread(actor, { agentId });
    await enableProjects(actor, false);
    const result = await fixture.chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "Disabled references",
        userMessage: {
          version: 1,
          parts: [mention(project.id), mention(project.id)],
        },
      },
      [404],
    );
    expect(result.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: "Project or conversation not found",
      },
    });
    expect(
      (await fixture.chat.listThreadEvents(actor, thread.id)).events,
    ).toStrictEqual([]);
  });

  it("retains request validation for malformed reference IDs", async () => {
    const actor = fixture.bdd.user();
    const response = await setupRawAppRequest({
      context,
      routes: chatEventsRoutes,
    })("/api/chat/events", {
      method: "POST",
      headers: {
        ...fixture.sessionHeaders(actor),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: randomUUID(),
        prompt: "Malformed project",
        hasTextContent: true,
        userMessage: { version: 1, parts: [mention("not-a-uuid")] },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("does not enqueue references for an already aborted application owner", async () => {
    const { actor, agentId } = await fixture.entitledNativeChatActor();
    await enableProjects(actor);
    const project = await createProject(actor, "Available");
    const thread = await fixture.chat.createThread(actor, { agentId });
    const response = await fixture.requestSendEventRaw(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "Aborted reference send",
        hasTextContent: true,
        userMessage: { version: 1, parts: [mention(project.id)] },
      },
      AbortSignal.abort(new DOMException("Application stopped", "AbortError")),
    );
    expect(response).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    expect(
      (await fixture.chat.listThreadEvents(actor, thread.id)).events,
    ).toStrictEqual([]);
  });

  it("keeps the captured input or rejects admission when a referenced project is deleted concurrently", async () => {
    const { actor, agentId } = await fixture.entitledNativeChatActor();
    await enableProjects(actor);
    const project = await createProject(actor, "Deleting");
    const thread = await fixture.chat.createThread(actor, { agentId });
    const eventId = randomUUID();
    const document: UserMessageInputDocument = {
      version: 1,
      parts: [mention(project.id), mention(project.id)],
    };
    const [sending, deletion] = await Promise.all([
      fixture.chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          clientEventId: eventId,
          prompt: "Concurrent deletion",
          userMessage: document,
        },
        [201, 404],
      ),
      projects().delete({
        headers: fixture.sessionHeaders(actor),
        params: { id: project.id },
        body: { eventId: createProjectOperationId(now(), randomUUID()) },
      }),
    ]);
    expect(deletion.status).toBe(204);
    await flushWaitUntilForTest();
    const events = await fixture.chat.listThreadEvents(actor, thread.id);
    const input = events.events.find((event) => {
      return event.id === eventId;
    });
    if (sending.status === 201) {
      expect(input).toMatchObject({ userMessage: document });
    } else {
      expect(input).toBeUndefined();
      expect(sending.body).toMatchObject({
        error: {
          code: "NOT_FOUND",
          message: "Project or conversation not found",
        },
      });
    }
    await expect(
      projects().get({
        headers: fixture.sessionHeaders(actor),
        params: { id: project.id },
      }),
    ).resolves.toMatchObject({ status: 404 });
  });
});

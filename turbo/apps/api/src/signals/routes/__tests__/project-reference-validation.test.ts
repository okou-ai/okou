import { randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { projectRoutes } from "../projects";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { installS3Fixture } from "./helpers/template-publish-fixture";

const context = testContext();
const fixture = createChatEventsFixture(context);

function projects() {
  return setupApp({ context, routes: projectRoutes })(projectsContract);
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
  it("admits ordinary chat messages without Project references", async () => {
    const { actor } = await fixture.entitledNativeChatActor();
    const run = await fixture.sendChatRun(actor, {
      prompt: "No project references",
    });
    expect((await fixture.api.readRun(actor, run.runId)).prompt).toBe(
      "No project references",
    );
    await fixture.cancelChatRun(actor, run.runId);
  });

  it("preserves multiple, repeated and mixed-case references in ordinary parts and feedback notes", async () => {
    const { actor } = await fixture.entitledNativeChatActor();
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

  it("uses the Project name captured before attachment verification", async () => {
    const { actor } = await fixture.entitledNativeChatActor();
    const project = await createProject(actor, "Research at send");
    const storage = installS3Fixture(context);
    const filename = "project.txt";
    const contentType = "text/plain";
    const bytes = Buffer.from("Project context");
    const upload = await fixture.chat.prepareUpload(actor, {
      filename,
      contentType,
      size: bytes.length,
    });
    if (!("uploadUrl" in upload)) {
      throw new Error("Expected a single-part upload");
    }
    storage.put(upload.uploadUrl, bytes, contentType);
    const key = storage.signedKey(upload.uploadUrl);
    const send = context.mocks.s3.send.getMockImplementation();
    if (!key || !send) {
      throw new Error("Expected an attachment object and storage transport");
    }
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand && command.input.Key === key) {
        await accept(
          projects().update({
            headers: fixture.sessionHeaders(actor),
            params: { id: project.id },
            body: {
              eventId: createProjectOperationId(now(), randomUUID()),
              name: "Research during verification",
            },
          }),
          [200],
        );
      }
      return await send(command);
    });
    const run = await fixture.sendChatRun(actor, {
      prompt: "Use the referenced Project",
      userMessage: {
        version: 1,
        parts: [
          mention(project.id),
          {
            type: "file",
            fileId: upload.id,
            filenameSnapshot: filename,
            contentType,
          },
        ],
      },
    });
    const { execution } = await fixture.runExecution(run.runId);
    expect(execution.appendSystemPrompt).toContain(
      'current name="Research at send"',
    );
    const renamed = await accept(
      projects().get({
        headers: fixture.sessionHeaders(actor),
        params: { id: project.id },
      }),
      [200],
    );
    expect(renamed.body.name).toBe("Research during verification");
    await fixture.cancelChatRun(actor, run.runId);
  });

  it.each(["ordinary", "feedback"] as const)(
    "rejects a mixed valid/missing batch from %s without publishing an input",
    async (location) => {
      const { actor } = await fixture.entitledNativeChatActor();
      const project = await createProject(actor, "Available");
      const thread = await fixture.chat.createThread(actor, {});
      const before = await fixture.chat.listThreadEvents(actor, thread.id);
      const references = [mention(project.id), mention(randomUUID())];
      const result = await fixture.chat.requestSendEvent(
        actor,
        {
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
      const { actor } = await fixture.entitledNativeChatActor();
      const own = await createProject(actor, "Own");
      const foreign = fixture.bdd.user(
        boundary === "user" ? { orgId: actor.orgId } : { userId: actor.userId },
      );
      const other = await createProject(foreign, "Private elsewhere");
      const result = await fixture.chat.requestSendEvent(
        actor,
        {
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
        prompt: "Malformed project",
        hasTextContent: true,
        userMessage: { version: 1, parts: [mention("not-a-uuid")] },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("does not enqueue references for an already aborted application owner", async () => {
    const { actor } = await fixture.entitledNativeChatActor();
    const project = await createProject(actor, "Available");
    const thread = await fixture.chat.createThread(actor, {});
    const response = await fixture.requestSendEventRaw(
      actor,
      {
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
    const { actor } = await fixture.entitledNativeChatActor();
    const project = await createProject(actor, "Deleting");
    const thread = await fixture.chat.createThread(actor, {});
    const eventId = randomUUID();
    const document: UserMessageInputDocument = {
      version: 1,
      parts: [mention(project.id), mention(project.id)],
    };
    const [sending, deletion] = await Promise.all([
      fixture.chat.requestSendEvent(
        actor,
        {
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

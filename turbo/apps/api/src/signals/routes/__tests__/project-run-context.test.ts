import { randomUUID } from "node:crypto";
import { test, expect } from "vitest";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import {
  chatEventsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-event-send";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { projectRoutes } from "../projects";
import { chatEventsRoutes } from "../chat-events";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const fixture = createChatEventsFixture(context);
function operation() {
  return createProjectOperationId(now(), randomUUID());
}
function projects() {
  return setupApp({ context, routes: projectRoutes })(projectsContract);
}
test("prepares queued inputs from current membership while preserving an already started Run and captured mentions", async () => {
  const { actor, agentId, runnerGroup } =
    await fixture.entitledNativeChatActor();
  if (!actor.orgId) {
    throw new Error("Missing organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.Projects]: true },
  );
  const first = await fixture.sendChatRun(actor, {
    agentId,
    prompt: "Start the work",
  });
  const claimed = await fixture.claimChatRun(runnerGroup, first.runId);
  const initial = await fixture.api.readRun(actor, first.runId);
  expect(initial.appendSystemPrompt).toContain("currently unassigned");
  const id = operation();
  await accept(
    projects().create({
      headers: fixture.sessionHeaders(actor),
      body: { id, eventId: id, name: "Launch", fromThreadId: first.threadId },
    }),
    [201],
  );
  const mentionId = operation();
  await accept(
    projects().create({
      headers: fixture.sessionHeaders(actor),
      body: { id: mentionId, eventId: mentionId, name: "Original research" },
    }),
    [201],
  );
  const inputId = randomUUID();
  const send = setupApp({ context, routes: chatEventsRoutes })(
    chatEventsContract,
  );
  const body: ChatEventSendBody = {
    agentId,
    threadId: first.threadId,
    clientEventId: inputId,
    prompt: "Review research",
    hasTextContent: true,
    userMessage: {
      version: 1,
      parts: [
        { type: "text", text: "Review " },
        {
          type: "project",
          projectId: mentionId,
          nameSnapshot: "Original research",
        },
      ],
    },
  };
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.Projects]: false,
    },
  );
  expect(
    (await send.send({ headers: fixture.sessionHeaders(actor), body })).status,
  ).toBe(404);
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.Projects]: true,
    },
  );
  expect(
    (
      await send.send({
        headers: fixture.sessionHeaders(actor),
        body: {
          ...body,
          userMessage: {
            version: 1 as const,
            parts: [
              {
                type: "project" as const,
                projectId: randomUUID(),
                nameSnapshot: "Unavailable",
              },
            ],
          },
        },
      })
    ).status,
  ).toBe(404);
  await accept(
    send.send({ headers: fixture.sessionHeaders(actor), body }),
    [201],
  );
  const latestId = operation();
  await accept(
    projects().create({
      headers: fixture.sessionHeaders(actor),
      body: {
        id: latestId,
        eventId: latestId,
        name: "Latest launch",
        fromThreadId: first.threadId,
      },
    }),
    [201],
  );
  await accept(
    projects().update({
      headers: fixture.sessionHeaders(actor),
      params: { id: mentionId },
      body: { eventId: operation(), name: "Current research" },
    }),
    [200],
  );
  expect(
    (await fixture.api.readRun(actor, first.runId)).appendSystemPrompt,
  ).toBe(initial.appendSystemPrompt);
  await fixture.cancelChatRun(actor, first.runId, claimed.sandboxHeaders);
  await flushWaitUntilForTest();
  const history = await fixture.waitForThreadMessages(
    actor,
    first.threadId,
    (items) => {
      return userMessages(items).some((event) => {
        return event.revokesEventId === inputId && event.runId !== undefined;
      });
    },
  );
  const nextId = userMessages(history.events).find((event) => {
    return event.revokesEventId === inputId;
  })?.runId;
  if (!nextId) {
    throw new Error("Queued Project input did not create a Run");
  }
  const nextClaim = await fixture.claimChatRun(runnerGroup, nextId);
  const next = await fixture.api.readRun(actor, nextId);
  expect(next.appendSystemPrompt).toContain(`PROJECT_ID=${latestId}`);
  expect(next.appendSystemPrompt).not.toContain(`Current Project: "Launch"`);
  expect(next.appendSystemPrompt).toContain("Current research");
  expect(next.appendSystemPrompt).toContain("Original research");
  expect(next.appendSystemPrompt).toContain("--limit all --json");
  await accept(
    projects().delete({
      headers: fixture.sessionHeaders(actor),
      params: { id: latestId },
      body: { eventId: operation() },
    }),
    [204],
  );
  expect((await fixture.api.readRun(actor, nextId)).appendSystemPrompt).toBe(
    next.appendSystemPrompt,
  );
  await fixture.cancelChatRun(actor, nextId, nextClaim.sandboxHeaders);
});

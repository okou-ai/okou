import type { ZodType } from "zod";
import { chatThreadsContract } from "../contracts/chat-threads";
import { chatEventsContract } from "../contracts/chat-event-send";
import type { KotlinRouteBinding, KotlinTypeBinding } from "./bindings";

/** Executable protocol proof only; installed command consumers register separately. */
export const kotlinCommandFixtureRoutes = [
  {
    name: "createThread",
    request: "CreateThreadRequest",
    response: "CreatedThread",
    route: chatThreadsContract.create,
  },
  {
    name: "send",
    request: "SendRequest",
    response: "AcceptedInput",
    route: chatEventsContract.send,
  },
] as const satisfies readonly KotlinRouteBinding[];

export const kotlinCommandFixtureTypes: readonly KotlinTypeBinding[] =
  kotlinCommandFixtureRoutes.flatMap(({ request, response, route }) => {
    return [
      { name: request, schema: route.body, direction: "input" as const },
      {
        name: response,
        schema: route.responses[201],
        direction: "output" as const,
      },
    ];
  });

const agentId = "22222222-2222-4222-8222-222222222222";
const threadId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const lifecycleId = "55555555-5555-4555-8555-555555555555";
const sortId = "66666666-6666-4666-8666-666666666666";
const runId = "77777777-7777-4777-8777-777777777777";
const date = "2026-11-14T00:00:00.000Z";
const text = "你好 Android 👋\nKeep **Markdown** and native input verbatim.";

function wire(schema: ZodType, value: unknown): unknown {
  // Keep the original wire, including canonical input transforms.
  schema.parse(value);
  return value;
}

export function kotlinCommandFixtureJson(): string {
  const normal = {
    agentId,
    prompt: text,
    clientEventId: eventId,
    chatThreadSortEventId: sortId,
    userMessage: { version: 1, parts: [{ type: "text", text }] },
    hasTextContent: true,
  };
  return (
    JSON.stringify(
      {
        createDefaults: wire(chatThreadsContract.create.body, {
          agentId,
          clientThreadId: threadId,
          eventId: lifecycleId,
        }),
        createAuto: wire(chatThreadsContract.create.body, {
          agentId,
          clientThreadId: threadId,
          eventId: lifecycleId,
          projectId,
          model: null,
          serviceTier: null,
          title: "项目 🧪",
        }),
        createPinned: wire(chatThreadsContract.create.body, {
          agentId,
          clientThreadId: threadId,
          model: "gpt-6.1-sol",
          serviceTier: "priority",
          reasoningEffort: "high",
        }),
        created: wire(chatThreadsContract.create.responses[201], {
          id: threadId,
          projectId,
          title: null,
          createdAt: date,
          selectedModel: null,
          serviceTier: null,
        }),
        newInput: wire(chatEventsContract.send.body, {
          ...normal,
          clientThreadId: threadId,
          chatThreadEventId: lifecycleId,
        }),
        existingInput: wire(chatEventsContract.send.body, {
          ...normal,
          threadId,
        }),
        explicitInput: wire(chatEventsContract.send.body, {
          ...normal,
          threadId,
          model: null,
          computerUseHostId: null,
          cloudBrowserEnabled: false,
        }),
        pinnedInput: wire(chatEventsContract.send.body, {
          ...normal,
          threadId,
          model: "gpt-6.1-sol",
          runOptions: { reasoningEffort: "high" },
        }),
        sourcedInput: wire(chatEventsContract.send.body, {
          ...normal,
          threadId,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text },
              { type: "source", kind: "mcp", clientId: "fixture-client" },
              {
                type: "model",
                selectedModel: "fixture-model",
                serviceTier: "priority",
              },
            ],
          },
        }),
        externalInput: wire(chatEventsContract.send.body, {
          ...normal,
          threadId,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text },
              {
                type: "source",
                kind: "slack",
                href: "https://source.example/message",
              },
            ],
          },
        }),
        forwardedInput: wire(chatEventsContract.send.body, {
          ...normal,
          threadId,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text },
              {
                type: "source",
                kind: "agent",
                runId,
                threadId,
                agentId,
                titleSnapshot: "Source conversation",
                href: "https://app.example/chat",
              },
            ],
          },
        }),
        revoke: wire(chatEventsContract.send.body, {
          agentId,
          threadId,
          revokesEventId: eventId,
          clientEventId: lifecycleId,
        }),
        interrupt: wire(chatEventsContract.send.body, {
          agentId,
          threadId,
          interruptsRunId: runId,
          clientEventId: lifecycleId,
        }),
        accepted: wire(chatEventsContract.send.responses[201], {
          threadId,
          createdAt: date,
        }),
        acceptedWithoutDate: wire(chatEventsContract.send.responses[201], {
          threadId,
        }),
      },
      null,
      2,
    ) + "\n"
  );
}

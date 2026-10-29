import { describe, expect, it } from "vitest";

import { semanticChatEventsFromChatEvents } from "../chat-event-semantics";
import {
  CHAT_EVENT_TYPES,
  foldChatRunStates,
  foldLatestChatUsageByRunId,
  foldPendingChatQueueEvents,
  foldRunnableChatQueueEvents,
  isChatEventContentTextType,
  isChatEventUserMessageTextType,
  isPendingChatQueueEvent,
  isValidChatEventRevocation,
  revokedChatEventIds,
  terminatedChatRunIds,
} from "../chat-events";
import {
  chatEventResponse,
  chatEventSchema,
  chatEventsContract,
  parseChatFollowupsContent,
  resolveChatEventRecommendedFollowups,
  serializeChatFollowupsContent,
  type ChatEvent,
} from "../chat-threads";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-23T00:00:00.000Z";

const chatEvents = [
  {
    id: "input-prompt",
    seqId: 1,
    threadId: THREAD_ID,
    eventType: "input.prompt",
    content: null,
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "Run the task" }],
    },
    createdAt: CREATED_AT,
  },
  {
    id: "input-automation",
    seqId: 2,
    threadId: THREAD_ID,
    eventType: "input.automation",
    content: null,
    userMessage: {
      version: 1,
      parts: [
        {
          type: "automation",
          workflowName: "inbox-triage",
          workflowId: "00000000-0000-4000-8000-000000000010",
          automationBrief: "Gmail label applied",
        },
      ],
    },
    createdAt: "2026-07-23T00:00:01.000Z",
  },
  {
    id: "input-budget",
    seqId: 3,
    threadId: THREAD_ID,
    eventType: "input.budget",
    content: null,
    runId: "run-1",
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "Five minutes remain" }],
    },
    createdAt: "2026-07-23T00:00:03.000Z",
  },
  {
    id: "input-rejected",
    seqId: 4,
    threadId: THREAD_ID,
    eventType: "input.rejected",
    content: null,
    userMessage: {
      version: 1,
      parts: [
        {
          type: "automation",
          workflowName: "inbox-triage",
          workflowId: "00000000-0000-4000-8000-000000000010",
          automationBrief: "Gmail label applied",
        },
      ],
    },
    error: "Insufficient credits",
    createdAt: CREATED_AT,
  },
  {
    id: "output-message",
    seqId: 5,
    threadId: THREAD_ID,
    eventType: "output.message",
    content: "Done",
    createdAt: CREATED_AT,
  },
  {
    id: "output-error",
    seqId: 6,
    threadId: THREAD_ID,
    eventType: "output.error",
    content: null,
    error: "Run failed",
    createdAt: CREATED_AT,
  },
  {
    id: "output-followups",
    seqId: 7,
    threadId: THREAD_ID,
    eventType: "output.followups",
    content: JSON.stringify({
      version: 1,
      followups: [{ prompt: "Continue", kind: "talk" }],
    }),
    createdAt: CREATED_AT,
  },
  {
    id: "run-completed",
    seqId: 8,
    threadId: THREAD_ID,
    eventType: "run.completed",
    runId: "run-1",
    content: null,
    runLifecycleEvent: "completed",
    createdAt: CREATED_AT,
  },
  {
    id: "run-failed",
    seqId: 9,
    threadId: THREAD_ID,
    eventType: "run.failed",
    runId: "run-2",
    content: null,
    runLifecycleEvent: "failed",
    createdAt: CREATED_AT,
  },
  {
    id: "run-cancelled",
    seqId: 10,
    threadId: THREAD_ID,
    eventType: "run.cancelled",
    runId: "run-3",
    content: null,
    runLifecycleEvent: "cancelled",
    createdAt: CREATED_AT,
  },
  {
    id: "control-interrupt",
    seqId: 11,
    threadId: THREAD_ID,
    eventType: "control.interrupt",
    content: null,
    interruptsRunId: "run-3",
    createdAt: CREATED_AT,
  },
  {
    id: "control-revoke",
    seqId: 12,
    threadId: THREAD_ID,
    eventType: "control.revoke",
    content: null,
    revokesEventId: "input-prompt",
    createdAt: CREATED_AT,
  },
  {
    id: "usage-recorded",
    seqId: 13,
    threadId: THREAD_ID,
    eventType: "usage.recorded",
    runId: "run-1",
    content: null,
    usage: {
      version: 1,
      totalCredits: 4,
      settledAt: CREATED_AT,
      breakdown: [],
    },
    createdAt: CREATED_AT,
  },
] satisfies ChatEvent[];

const queueFoldFixture = [
  {
    id: "automation-oldest",
    eventType: "input.automation",
    createdAt: "2026-07-23T00:00:00.000Z",
  },
  {
    id: "prompt-newer",
    eventType: "input.prompt",
    createdAt: "2026-07-23T00:01:00.000Z",
  },
  {
    id: "prompt-claimed",
    eventType: "input.prompt",
    runId: "run-claimed",
    createdAt: "2026-07-23T00:00:30.000Z",
  },
  {
    id: "automation-revoked",
    eventType: "input.automation",
    createdAt: "2026-07-23T00:00:15.000Z",
  },
  {
    id: "automation-revoker",
    eventType: "control.revoke",
    revokesEventId: "automation-revoked",
    createdAt: "2026-07-23T00:02:00.000Z",
  },
] as const;

describe("ChatEvent catalog", () => {
  it("parses exactly one canonical fixture for every catalog leaf", () => {
    expect(
      chatEvents.map((event) => {
        return event.eventType;
      }),
    ).toStrictEqual(CHAT_EVENT_TYPES);
    for (const event of chatEvents) {
      expect(chatEventSchema.parse(event)).toStrictEqual(event);
    }
  });

  it("fails closed for unknown leaves and server-only fields", () => {
    const prompt = chatEvents[0];
    expect(
      chatEventSchema.safeParse({ ...prompt, eventType: "input.unknown" })
        .success,
    ).toBe(false);
    expect(
      chatEventSchema.safeParse({
        ...prompt,
        encryptedParams: "must-stay-server-side",
      }).success,
    ).toBe(false);
    const automation = chatEvents[1];
    expect(
      chatEventSchema.safeParse({
        ...automation,
        encryptedParams: "must-stay-server-side",
      }).success,
    ).toBe(false);
    expect(
      chatEventSchema.safeParse({
        ...automation,
        triggerSource: "automation-event",
      }).success,
    ).toBe(false);
  });

  it("classifies only conversation-bearing fields as text", () => {
    expect(
      CHAT_EVENT_TYPES.filter(isChatEventUserMessageTextType),
    ).toStrictEqual(["input.prompt", "input.rejected"]);
    expect(CHAT_EVENT_TYPES.filter(isChatEventContentTextType)).toStrictEqual([
      "output.message",
      "output.error",
      "run.completed",
      "run.failed",
      "run.cancelled",
    ]);
    expect(isChatEventContentTextType("output.followups")).toBe(false);
  });

  it("emits canonical responses for every catalog leaf", () => {
    for (const event of chatEvents) {
      const response = chatEventResponse(event);
      expect(response).toStrictEqual(event);
      expect(chatEventSchema.parse(response)).toStrictEqual(response);
    }
  });
});

describe("ChatEvent revocation rules", () => {
  const validPairs = new Set([
    "input.prompt->input.prompt",
    "input.prompt->input.automation",
    "input.prompt->output.followups",
    "input.budget->input.budget",
    "input.rejected->input.prompt",
    "input.rejected->input.automation",
    "input.rejected->output.followups",
    "control.revoke->input.prompt",
    "control.revoke->input.automation",
    "control.revoke->input.budget",
    "control.revoke->input.rejected",
    "usage.recorded->usage.recorded",
  ]);

  it("accepts only the registered source and target leaf pairs", () => {
    for (const sourceType of CHAT_EVENT_TYPES) {
      for (const targetType of CHAT_EVENT_TYPES) {
        expect(isValidChatEventRevocation(sourceType, targetType)).toBe(
          validPairs.has(`${sourceType}->${targetType}`),
        );
      }
    }
  });
});

describe("output.followups content", () => {
  const followups = [
    {
      prompt: "Generate a launch page",
      kind: "generate" as const,
      generationType: "website" as const,
    },
  ];
  const content = JSON.stringify({ version: 1, followups });

  it("strictly parses the version-1 document without losing item fields", () => {
    const event = chatEvents.find((candidate) => {
      return candidate.eventType === "output.followups";
    });
    if (!event) {
      throw new Error("Missing followups fixture");
    }
    expect(chatEventSchema.parse({ ...event, content })).toStrictEqual({
      ...event,
      content,
    });
    expect(serializeChatFollowupsContent(followups)).toBe(content);
    expect(parseChatFollowupsContent(content)).toStrictEqual({
      version: 1,
      followups,
    });
    expect(
      parseChatFollowupsContent(JSON.stringify({ version: 2, followups })),
    ).toBeNull();
    expect(
      parseChatFollowupsContent(
        JSON.stringify({
          version: 1,
          followups: [{ ...followups[0], unsupported: true }],
        }),
      ),
    ).toBeNull();
    expect(parseChatFollowupsContent("not json")).toBeNull();
  });

  it("reads only valid v1 content and fails safely otherwise", () => {
    expect(resolveChatEventRecommendedFollowups({ content })).toStrictEqual(
      followups,
    );
    expect(
      resolveChatEventRecommendedFollowups({ content: "not json" }),
    ).toStrictEqual([]);
  });
});

describe("ChatEvent folds", () => {
  it("folds each run to its terminal lifecycle state", () => {
    const completed = chatEvents.find((event) => {
      return event.eventType === "run.completed";
    });
    if (!completed) {
      throw new Error("Missing run fold fixture");
    }

    expect(foldChatRunStates([completed]).get("run-1")).toBe("completed");
    expect(terminatedChatRunIds([completed])).toStrictEqual(new Set(["run-1"]));
  });

  it("keeps the latest settled usage snapshot for each run", () => {
    const usage = chatEvents.find((event) => {
      return event.eventType === "usage.recorded";
    });
    if (!usage) {
      throw new Error("Missing usage fold fixture");
    }
    const latest = {
      ...usage,
      id: "usage-latest",
      usage: {
        ...usage.usage,
        totalCredits: 8,
        settledAt: "2026-07-23T00:02:00.000Z",
      },
    };
    const stale = {
      ...usage,
      id: "usage-stale",
      usage: {
        ...usage.usage,
        totalCredits: 6,
        settledAt: "2026-07-23T00:01:00.000Z",
      },
    };

    expect(
      foldLatestChatUsageByRunId([usage, latest, stale]).get("run-1")
        ?.totalCredits,
    ).toBe(8);
  });

  it("collects immutable revoke relationships without hiding source facts", () => {
    expect(revokedChatEventIds(chatEvents)).toStrictEqual(
      new Set(["input-prompt"]),
    );
  });

  it("folds pending queue events by class priority, original time, and revoke state", () => {
    const revoked = revokedChatEventIds(queueFoldFixture);
    expect(isPendingChatQueueEvent(queueFoldFixture[1], revoked)).toBe(true);
    expect(isPendingChatQueueEvent(queueFoldFixture[3], revoked)).toBe(false);
    expect(
      foldPendingChatQueueEvents(queueFoldFixture).map((event) => {
        return event.id;
      }),
    ).toStrictEqual(["prompt-newer", "automation-oldest"]);
  });

  it("returns every pending queue event as runnable", () => {
    expect(
      foldRunnableChatQueueEvents(queueFoldFixture).map((event) => {
        return event.id;
      }),
    ).toStrictEqual(["prompt-newer", "automation-oldest"]);
  });
});

describe("ChatEvent semantic projection", () => {
  it("preserves independent origins and submission times through interleaved replacement chains", () => {
    const prompt = {
      id: "prompt-origin",
      seqId: 1,
      threadId: THREAD_ID,
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Run the task" }],
      },
      createdAt: CREATED_AT,
    } satisfies ChatEvent;
    const automation = {
      ...prompt,
      id: "automation-origin",
      seqId: 2,
      eventType: "input.automation",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: "inbox-triage",
            automationBrief: "Gmail label applied",
          },
        ],
      },
      createdAt: "2026-07-23T00:00:01.000Z",
    } satisfies ChatEvent;
    const replacedPrompt = {
      ...prompt,
      id: "prompt-replacement",
      seqId: 3,
      revokesEventId: prompt.id,
      createdAt: "2026-07-23T00:00:02.000Z",
    } satisfies ChatEvent;
    const replacedAutomation = {
      ...automation,
      id: "automation-replacement",
      seqId: 4,
      eventType: "input.prompt",
      revokesEventId: automation.id,
      createdAt: "2026-07-23T00:00:03.000Z",
    } satisfies ChatEvent;
    const deliveredPrompt = {
      ...replacedPrompt,
      id: "prompt-delivered",
      seqId: 5,
      runId: "run-prompt",
      revokesEventId: replacedPrompt.id,
      createdAt: "2026-07-23T00:00:04.000Z",
    } satisfies ChatEvent;
    const rejectedAutomation = {
      ...replacedAutomation,
      id: "automation-rejected",
      seqId: 6,
      eventType: "input.rejected",
      revokesEventId: replacedAutomation.id,
      error: "Insufficient credits",
      createdAt: "2026-07-23T00:00:05.000Z",
    } satisfies ChatEvent;

    expect(
      semanticChatEventsFromChatEvents([
        prompt,
        automation,
        replacedPrompt,
        replacedAutomation,
        deliveredPrompt,
        rejectedAutomation,
      ]),
    ).toStrictEqual([
      {
        event: deliveredPrompt,
        isQueued: false,
        inputCreatedAt: prompt.createdAt,
        inputOriginId: prompt.id,
      },
      {
        event: rejectedAutomation,
        isQueued: false,
        inputCreatedAt: automation.createdAt,
        inputOriginId: automation.id,
      },
    ]);
  });

  it("projects interleaved recalls, automation rejection, interruptions, and queue associations", () => {
    const base = {
      threadId: THREAD_ID,
      content: null,
      createdAt: CREATED_AT,
    } as const;
    const queuedAutomation = {
      ...base,
      id: "automation-queued",
      seqId: 1,
      eventType: "input.automation",
    } satisfies ChatEvent;
    const recalledAutomation = {
      ...queuedAutomation,
      id: "automation-recalled",
      seqId: 2,
    } satisfies ChatEvent;
    const rejectedAutomation = {
      ...queuedAutomation,
      id: "automation-rejected",
      seqId: 3,
    } satisfies ChatEvent;
    const cancellation = {
      ...base,
      id: "run-cancelled",
      seqId: 4,
      eventType: "run.cancelled",
      runId: "run-interrupted",
      runLifecycleEvent: "cancelled",
    } satisfies ChatEvent;
    const pendingPrompt = {
      ...base,
      id: "prompt-pending",
      seqId: 5,
      eventType: "input.prompt",
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Continue" }],
      },
    } satisfies ChatEvent;
    const recall = {
      ...base,
      id: "automation-recall",
      seqId: 6,
      eventType: "control.revoke",
      revokesEventId: recalledAutomation.id,
    } satisfies ChatEvent;
    const rejection = {
      ...pendingPrompt,
      id: "automation-rejection",
      seqId: 7,
      eventType: "input.rejected",
      revokesEventId: rejectedAutomation.id,
      error: "Insufficient credits",
    } satisfies ChatEvent;
    const interrupt = {
      ...base,
      id: "run-interrupt",
      seqId: 8,
      eventType: "control.interrupt",
      interruptsRunId: cancellation.runId,
      createdAt: "2026-07-23T00:00:01.000Z",
    } satisfies ChatEvent;
    const runningAutomation = {
      ...queuedAutomation,
      id: "automation-running",
      seqId: 9,
      runId: "run-active",
    } satisfies ChatEvent;
    const otherCancellation = {
      ...cancellation,
      id: "other-run-cancelled",
      seqId: 10,
      runId: "run-other",
    } satisfies ChatEvent;
    const optimisticAutomation = {
      ...base,
      id: "automation-optimistic",
      eventType: "input.automation",
      optimisticUserMessageAssociation: "run",
    } as const;

    expect(
      semanticChatEventsFromChatEvents([
        queuedAutomation,
        recalledAutomation,
        rejectedAutomation,
        cancellation,
        pendingPrompt,
        recall,
        rejection,
        interrupt,
        runningAutomation,
        otherCancellation,
        optimisticAutomation,
      ]),
    ).toStrictEqual([
      {
        event: queuedAutomation,
        isQueued: true,
        inputCreatedAt: queuedAutomation.createdAt,
        inputOriginId: queuedAutomation.id,
      },
      {
        event: pendingPrompt,
        isQueued: false,
        inputCreatedAt: pendingPrompt.createdAt,
        inputOriginId: pendingPrompt.id,
      },
      {
        event: {
          ...base,
          id: interrupt.id,
          seqId: interrupt.seqId,
          eventType: "run.cancelled",
          content: "Run cancelled",
          runId: cancellation.runId,
          error: "Run cancelled",
          runLifecycleEvent: "cancelled",
          createdAt: interrupt.createdAt,
        },
        isQueued: false,
      },
      {
        event: runningAutomation,
        isQueued: false,
        inputCreatedAt: runningAutomation.createdAt,
        inputOriginId: runningAutomation.id,
      },
      {
        event: otherCancellation,
        isQueued: false,
        inputCreatedAt: undefined,
        inputOriginId: undefined,
      },
      {
        event: optimisticAutomation,
        isQueued: false,
        inputCreatedAt: optimisticAutomation.createdAt,
        inputOriginId: optimisticAutomation.id,
      },
    ]);
  });
});

describe("ChatEvent HTTP contracts", () => {
  it("uses event naming for the canonical send route", () => {
    expect(chatEventsContract.send.path).toBe("/api/chat/events");
  });

  it("uses event ids in canonical write bodies", () => {
    const parsed = chatEventsContract.send.body.parse({
      agentId: "agent-1",
      threadId: THREAD_ID,
      revokesEventId: "input-prompt",
      clientEventId: "00000000-0000-4000-8000-000000000002",
    });

    expect(parsed).toMatchObject({
      revokesEventId: "input-prompt",
      clientEventId: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("accepts only the declared send body fields", () => {
    const request = {
      agentId: "agent-1",
      prompt: "Run the task",
      threadId: THREAD_ID,
      userMessage: {
        version: 1 as const,
        parts: [{ type: "text" as const, text: "Run the task" }],
      },
      hasTextContent: true,
    };

    expect(chatEventsContract.send.body.safeParse(request).success).toBe(true);
    expect(
      chatEventsContract.send.body.safeParse({
        ...request,
        unsupportedField: "value",
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { imageModelIdSchema } from "../image-models";
import {
  chatThreadByIdContract,
  chatEventsContract,
  chatThreadComputerUseHostContract,
  chatThreadDraftSchema,
  chatThreadEventSchema,
  chatThreadArtifactGoogleDriveSyncSchema,
  chatThreadsContract,
  chatEventSchema,
  generationTemplateRequestSchema,
  userMessageDocumentSchema,
  userMessageInputDocumentSchema,
} from "../chat-threads";

describe("google drive artifact recovery contract", () => {
  it("requires account readiness on every connected sync status", () => {
    const legacyNotSynced = { status: "not_synced" } as const;
    const accountReadyNotSynced = {
      status: "not_synced",
      accountReady: true,
    } as const;
    const previousNotSyncedSchema = z.object({
      status: z.literal("not_synced"),
    });

    expect(
      chatThreadArtifactGoogleDriveSyncSchema.safeParse(legacyNotSynced)
        .success,
    ).toBe(false);
    // An App bundle built before the marker keeps its own tolerant parser.
    expect(previousNotSyncedSchema.parse(accountReadyNotSynced)).toStrictEqual(
      legacyNotSynced,
    );
    expect(
      chatThreadArtifactGoogleDriveSyncSchema.parse(accountReadyNotSynced),
    ).toStrictEqual(accountReadyNotSynced);
    expect(
      chatThreadArtifactGoogleDriveSyncSchema.parse({
        status: "unknown",
        accountReady: true,
      }),
    ).toStrictEqual({ status: "unknown", accountReady: true });
  });

  it("keeps disconnected recovery additive across API and Platform versions", () => {
    const legacyDisconnected = { status: "disconnected" } as const;
    const exactReconnect = {
      status: "disconnected",
      recovery: {
        action: "reconnect",
        connectionId: "11111111-1111-4111-8111-111111111111",
      },
    } as const;
    const previousDisconnectedSchema = z.object({
      status: z.literal("disconnected"),
    });

    expect(
      chatThreadArtifactGoogleDriveSyncSchema.parse(legacyDisconnected),
    ).toStrictEqual(legacyDisconnected);
    expect(previousDisconnectedSchema.parse(exactReconnect)).toStrictEqual(
      legacyDisconnected,
    );
    expect(
      chatThreadArtifactGoogleDriveSyncSchema.parse(exactReconnect),
    ).toStrictEqual(exactReconnect);
    expect(
      chatThreadArtifactGoogleDriveSyncSchema.safeParse({
        status: "disconnected",
        recovery: { action: "reconnect", connectionId: "not-a-uuid" },
      }).success,
    ).toBe(false);
  });
});

describe("chat message response contract", () => {
  const workflowId = "11111111-1111-4111-8111-111111111111";

  it("rejects API messages without a sequence ID", () => {
    const parsed = chatEventSchema.safeParse({
      id: "message-1",
      threadId: "thread-1",
      eventType: "input.prompt",
      content: null,
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts workflow display metadata only as a user-message part", () => {
    const automationPart = {
      type: "automation" as const,
      workflowName: "scheduled-workflow",
      workflowId,
      automationBrief: "Daily schedule fired",
    };
    const parsed = chatEventSchema.safeParse({
      id: "message-1",
      threadId: "thread-1",
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [automationPart],
      },
      seqId: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.eventType !== "input.prompt") {
      return;
    }
    expect(parsed.data.userMessage.parts).toStrictEqual([automationPart]);
  });

  it("exposes user input documents as userMessage", () => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Run the task" }],
    };
    const event = chatEventSchema.safeParse({
      id: "message-1",
      threadId: "thread-1",
      eventType: "input.prompt",
      content: null,
      userMessage,
      seqId: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const send = chatEventsContract.send.body.safeParse({
      agentId: "agent-1",
      hasTextContent: true,
      prompt: "Run the task",
      userMessage,
    });

    expect(event).toMatchObject({ success: true, data: { userMessage } });
    expect(send).toMatchObject({ success: true, data: { userMessage } });
  });

  it("accepts canonical thread draft responses", () => {
    const response = {
      draftUserMessage: {
        version: 1 as const,
        parts: [{ type: "text" as const, text: "Resume the draft" }],
      },
      draftAttachments: null,
    };

    expect(chatThreadDraftSchema.parse(response)).toStrictEqual(response);
  });

  it("requires userMessage for non-empty thread drafts", () => {
    expect(
      chatThreadByIdContract.patch.body.safeParse({
        draftUserMessage: null,
        draftAttachments: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      chatThreadByIdContract.patch.body.safeParse({
        draftUserMessage: null,
        draftAttachments: [
          {
            id: "draft-file",
            filename: "brief.md",
            contentType: "text/markdown",
            size: 42,
            url: "https://example.com/brief.md",
          },
        ],
      }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            path: ["draftUserMessage"],
          }),
        ],
      },
    });
  });
});

describe("chat thread event sequence contract", () => {
  it("coerces current sequence cursors", () => {
    expect(
      chatThreadsContract.events.query.safeParse({ sinceSeqId: "42" }),
    ).toMatchObject({
      success: true,
      data: { sinceSeqId: 42 },
    });
  });

  it("accepts video model fields and pre-image-model payloads", () => {
    const selectedImageModel = imageModelIdSchema.parse("fal-ai/qwen-image");
    const createdAt = "2026-08-17T00:00:00.000Z";
    const imageModelEvent = {
      id: "11111111-1111-4111-8111-111111111111",
      seqId: 1,
      kind: "image_model_updated" as const,
      chatThreadId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      title: null,
      selectedVideoModel: null,
      selectedImageModel,
      createdAt,
    };

    expect(chatThreadEventSchema.parse(imageModelEvent)).toMatchObject({
      kind: "image_model_updated",
      selectedImageModel,
    });

    const snapshotThread = {
      id: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      title: "Cached before image model persistence",
      sortAt: createdAt,
      createdAt,
      updatedAt: createdAt,
      pinnedAt: null,
      renamedAt: null,
      selectedVideoModel: null,
    };
    const snapshotResponse = {
      chatThreads: [snapshotThread],
      latestEventId: null,
      latestSeqId: null,
    };

    expect(
      chatThreadsContract.snapshot.responses[200].safeParse(snapshotResponse)
        .success,
    ).toBe(true);
  });
});

describe("chat thread computer access contract", () => {
  const hostId = "11111111-1111-4111-8111-111111111111";

  it("accepts Cloud browser as an explicit thread selection", () => {
    expect(
      chatThreadComputerUseHostContract.update.body.safeParse({
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      }),
    ).toMatchObject({ success: true });
  });

  it("rejects selecting Cloud browser and Computer Use together", () => {
    expect(
      chatEventsContract.send.body.safeParse({
        agentId: "agent-1",
        prompt: "Browse from both places",
        computerUseHostId: hostId,
        cloudBrowserEnabled: true,
      }),
    ).toMatchObject({ success: false });
    expect(
      chatEventsContract.send.body.safeParse({
        agentId: "agent-1",
        prompt: "Review this image",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: "original-file",
              filenameSnapshot: "billing.png",
              contentType: "image/png",
              annotatedFileId: "annotated-file",
            },
          ],
        },
      }),
    ).toMatchObject({ success: false });
    expect(
      chatThreadComputerUseHostContract.update.body.safeParse({
        computerUseHostId: hostId,
        cloudBrowserEnabled: true,
      }),
    ).toMatchObject({ success: false });
  });
});

describe("chat thread generation template contract", () => {
  it("allows at most one non-content user-message part", () => {
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "source", kind: "slack" },
          {
            type: "automation",
            workflowName: "daily-digest",
          },
        ],
      }),
    ).toMatchObject({ success: false });
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "text", text: "Visible content" },
          { type: "goal", goalBrief: "Finish the rollout" },
        ],
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts an internal agent-run source annotation", () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const threadId = "00000000-0000-4000-8000-000000000002";
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "text", text: "Delegated prompt" },
          {
            type: "source",
            kind: "agent",
            runId,
            threadId,
            agentId: "00000000-0000-4000-8000-000000000003",
            titleSnapshot: "New thread",
            href: `/chats/${threadId}#run-${runId}`,
          },
        ],
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts one model annotation in sends but rejects it in draft input", () => {
    const userMessage = {
      version: 1,
      parts: [
        { type: "text", text: "Run with this model" },
        {
          type: "model",
          selectedModel: "gpt-5.6-sol",
          serviceTier: "priority",
        },
      ],
    };
    expect(userMessageDocumentSchema.safeParse(userMessage)).toMatchObject({
      success: true,
    });
    expect(
      chatEventsContract.send.body.safeParse({
        agentId: "agent-1",
        prompt: "Run with this model",
        hasTextContent: true,
        model: "claude-sonnet-4-6",
        userMessage,
      }),
    ).toMatchObject({ success: true });
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          ...userMessage.parts,
          { type: "model", selectedModel: "gpt-5.6-sol" },
        ],
      }),
    ).toMatchObject({ success: false });
    expect(userMessageInputDocumentSchema.safeParse(userMessage)).toMatchObject(
      { success: false },
    );
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "text", text: "Run with an invalid tier" },
          {
            type: "model",
            selectedModel: "gpt-5.6-sol",
            serviceTier: "fast",
          },
        ],
      }),
    ).toMatchObject({ success: false });
  });

  it("stores editable image annotations in drafts and requires the rendered file for sends", () => {
    const annotations = {
      marks: [
        {
          id: "mark-1",
          shape: "box" as const,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          ink: "#5E6AD2" as const,
          note: "Tighten this spacing",
        },
      ],
    };
    const draftUserMessage = {
      version: 1 as const,
      parts: [
        {
          type: "file" as const,
          fileId: "original-file",
          filenameSnapshot: "billing.png",
          contentType: "image/png",
          annotations,
        },
      ],
    };

    expect(
      userMessageInputDocumentSchema.safeParse(draftUserMessage),
    ).toMatchObject({ success: true });
    expect(
      chatEventsContract.send.body.safeParse({
        agentId: "agent-1",
        prompt: "Review this image",
        hasTextContent: true,
        userMessage: draftUserMessage,
      }),
    ).toMatchObject({ success: false });
    expect(
      chatEventsContract.send.body.safeParse({
        agentId: "agent-1",
        prompt: "Review this image",
        hasTextContent: true,
        userMessage: {
          ...draftUserMessage,
          parts: [
            {
              ...draftUserMessage.parts[0],
              annotatedFileId: "annotated-file",
            },
          ],
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts template parts inside feedback notes", () => {
    const parsed = userMessageDocumentSchema.safeParse({
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "Original reply",
          note: [
            { type: "text", text: "Use " },
            {
              type: "template",
              titleSnapshot: "Paper cut",
              template: {
                type: "illustration",
                selection: { illustrationStyleId: "paper-cut" },
              },
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts referenced feedback passages without a user comment", () => {
    const userMessage = {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "Original reply",
          note: [],
        },
      ],
    };

    expect(userMessageDocumentSchema.safeParse(userMessage)).toMatchObject({
      success: true,
    });
    expect(userMessageInputDocumentSchema.safeParse(userMessage)).toMatchObject(
      { success: true },
    );
  });

  it("accepts feedback event ranges without requiring them on legacy data", () => {
    const legacyFeedback = {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "Original reply",
          note: [{ type: "text", text: "Clarify this" }],
        },
      ],
    };
    const locatedFeedback = {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "reply",
          note: [{ type: "text", text: "Clarify this" }],
          eventId: "assistant-event-1",
          range: { start: 9, end: 14 },
        },
      ],
    };

    expect(userMessageDocumentSchema.safeParse(legacyFeedback)).toMatchObject({
      success: true,
    });
    expect(userMessageDocumentSchema.safeParse(locatedFeedback)).toMatchObject({
      success: true,
    });
    expect(
      userMessageDocumentSchema.safeParse({
        ...locatedFeedback,
        parts: [{ ...locatedFeedback.parts[0], range: undefined }],
      }),
    ).toMatchObject({ success: false });
    expect(
      userMessageDocumentSchema.safeParse({
        ...locatedFeedback,
        parts: [
          {
            ...locatedFeedback.parts[0],
            range: { start: 14, end: 14 },
          },
        ],
      }),
    ).toMatchObject({ success: false });
  });

  it("accepts presentation template selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "presentation",
      selection: {
        templateId: "template:html-ppt-playful-launch",
        colorSystemId: "color-system:carnival",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects presentation selections with design-system ids", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "presentation",
      selection: {
        designSystemId: "design-system:playful-editorial",
        templateId: "template:html-ppt-playful-launch",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("preserves explicit brand motion selections in messages and drafts", () => {
    const template = {
      type: "brand-motion",
      selection: { templateId: "brand-motion:brand-mask-sweep-lockup" },
    } as const;
    expect(generationTemplateRequestSchema.parse(template)).toStrictEqual(
      template,
    );
    const userMessage = {
      version: 1,
      parts: [
        { type: "text", text: "Animate my brand" },
        { type: "template", titleSnapshot: "Mask Sweep", template },
      ],
    } as const;
    expect(userMessageInputDocumentSchema.parse(userMessage)).toStrictEqual(
      userMessage,
    );
    expect(userMessageDocumentSchema.parse(userMessage)).toStrictEqual(
      userMessage,
    );
    expect(
      chatThreadDraftSchema.parse({
        draftUserMessage: userMessage,
        draftAttachments: null,
      }),
    ).toMatchObject({ draftUserMessage: userMessage });
  });

  it.each([
    {},
    { templateId: "" },
    { stylePresetId: "brand-motion:brand-mask-sweep-lockup" },
    {
      templateId: "brand-motion:brand-mask-sweep-lockup",
      stylePresetId: "video-template:cinematic",
    },
    {
      templateId: "brand-motion:brand-mask-sweep-lockup",
      explainerOptions: {},
    },
  ])("rejects invalid brand motion selection fields %j", (selection) => {
    expect(
      generationTemplateRequestSchema.safeParse({
        type: "brand-motion",
        selection,
      }).success,
    ).toBe(false);
  });

  it("accepts workflow template selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "workflow",
      selection: {
        workflowTemplateId: "workflow-template:auto-inbox-label",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts avatar snapshots in the compatible video template envelope", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "video",
      selection: {
        stylePresetId: "avatar-template:81",
        titleSnapshot: "Ada",
        previewUrl: "https://example.com/ada.jpg",
        voiceId: "en-US-ChristopherNeural",
        aspectRatio: "landscape",
      },
    });

    expect(parsed).toMatchObject({
      success: true,
      data: {
        type: "video",
        selection: {
          stylePresetId: "avatar-template:81",
          titleSnapshot: "Ada",
          previewUrl: "https://example.com/ada.jpg",
          voiceId: "en-US-ChristopherNeural",
          aspectRatio: "landscape",
        },
      },
    });
  });

  it("rejects empty workflow template ids", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "workflow",
      selection: { workflowTemplateId: "" },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts website template selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "website",
      selection: {
        websiteTemplateId: "website-template:warm-cards",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects empty website template ids", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "website",
      selection: { websiteTemplateId: "" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects extra website selection fields", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "website",
      selection: {
        templateId: "template:warm-cards",
        websiteTemplateId: "website-template:warm-cards",
      },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("live message admission and retained Goal drafts", () => {
  it("rejects Goal work at send while decoding historical parts and saved drafts", () => {
    const legacy = {
      version: 1,
      parts: [{ type: "goal", goalBrief: "Retained objective" }],
    };
    expect(userMessageInputDocumentSchema.parse(legacy)).toStrictEqual(legacy);
    expect(userMessageDocumentSchema.parse(legacy)).toStrictEqual(legacy);
    const send = {
      agentId: "agent-1",
      prompt: "Retained objective",
      hasTextContent: false,
      userMessage: legacy,
    };
    expect(chatEventsContract.send.body.safeParse(send).success).toBe(false);
    expect(
      chatEventsContract.send.body.safeParse({
        ...send,
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Ordinary work" }],
        },
      }).success,
    ).toBe(true);
  });
});

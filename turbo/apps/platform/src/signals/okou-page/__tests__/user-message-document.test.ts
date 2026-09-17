import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  userMessageDocumentSchema,
  type GenerationTemplateRequest,
  type PersistedAttachment,
  type UserMessageDocument,
  type UserMessageInputDocument,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";
import {
  editorDocToMessageDocument,
  messageDocumentToDisplayText,
  messageDocumentToEditorDoc,
  messageDocumentToPrompt,
  type MessageDocumentAttachment,
} from "../user-message-document-codec.ts";

function createEditorSchema(): Schema {
  return new Schema({
    nodes: {
      doc: { content: "block*" },
      paragraph: { content: "inline*", group: "block" },
      text: { group: "inline" },
      hardBreak: { group: "inline", inline: true },
      agentMention: {
        atom: true,
        attrs: {
          agentId: { default: null },
          avatarUrl: { default: null },
          name: { default: null },
        },
        group: "inline",
        inline: true,
      },
      chatThreadMention: {
        atom: true,
        attrs: {
          threadId: { default: null },
          title: { default: null },
        },
        group: "inline",
        inline: true,
      },
      inlineTemplate: {
        atom: true,
        attrs: {
          category: { default: null },
          previewImageUrl: { default: null },
          template: { default: null },
          templateType: { default: null },
          title: { default: null },
        },
        group: "inline",
        inline: true,
      },
      templateAttachment: {
        atom: true,
        attrs: {
          templateType: { default: null },
          title: { default: null },
        },
        group: "block",
      },
      feedbackItem: {
        attrs: {
          eventId: { default: null },
          feedbackId: { default: null },
          fill: { default: false },
          quote: { default: null },
          rangeEnd: { default: null },
          rangeStart: { default: null },
          showDivider: { default: false },
          sourceId: { default: null },
          sourceSentId: { default: null },
          sourceStatus: { default: null },
          sourceType: { default: null },
        },
        content: "paragraph*",
        group: "block",
      },
    },
  });
}

const CHAT_THREAD_ID = "b0000000-0000-4000-a000-000000000931";
const AGENT_ID = "c0000000-0000-4000-a000-000000000931";

function restoredEditorDocument(value: unknown): ProseMirrorNode {
  const restored = messageDocumentToEditorDoc(value);
  if (!restored) {
    throw new Error("User message could not be restored for editing");
  }
  return createEditorSchema().nodeFromJSON(restored);
}

function saveRestoredMessage(
  value: UserMessageDocument,
  attachments: readonly PersistedAttachment[] = [],
): UserMessageInputDocument {
  const saved = editorDocToMessageDocument(restoredEditorDocument(value), {
    attachments,
  });
  if (!saved) {
    throw new Error("Restored user message could not be saved");
  }
  return saved;
}

function templatePart(
  titleSnapshot: string,
  template: GenerationTemplateRequest,
): Extract<UserMessagePart, { type: "template" }> {
  return { type: "template", titleSnapshot, template };
}

function expectTextOrder(text: string, segments: readonly string[]): void {
  let priorIndex = -1;
  for (const segment of segments) {
    const index = text.indexOf(segment, priorIndex + 1);
    expect(index).toBeGreaterThan(priorIndex);
    priorIndex = index;
  }
}

test("Every generation template type restores for editing", () => {
  const templates = [
    templatePart("Paper cut", {
      type: "illustration",
      selection: { illustrationStyleId: "paper-cut" },
    }),
    templatePart("Epic grandeur", {
      type: "video",
      selection: { stylePresetId: "epic-grandeur" },
    }),
    templatePart("Daily review", {
      type: "workflow",
      selection: { workflowTemplateId: "daily-review" },
    }),
    templatePart("Black slabs", {
      type: "website",
      selection: { websiteTemplateId: "website-template:black-slabs" },
    }),
  ] as const;

  for (const template of templates) {
    const document: UserMessageDocument = {
      version: 1,
      parts: [template],
    };
    expect(saveRestoredMessage(document)).toStrictEqual(document);
  }
});

test("Complex composer content survives saving and restoring", () => {
  const firstAttachment: PersistedAttachment = {
    id: "f0000000-0000-4000-a000-000000000931",
    url: "https://cdn.vm0.io/messages/launch-brief.pdf",
    filename: "launch-brief.pdf",
    contentType: "application/pdf",
    size: 4096,
  };
  const secondAttachment: PersistedAttachment = {
    id: "f0000000-0000-4000-a000-000000000932",
    url: "https://cdn.vm0.io/messages/timeline.csv",
    filename: "timeline.csv",
    contentType: "text/csv",
    size: 2048,
  };
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      {
        type: "file",
        fileId: firstAttachment.id,
        filenameSnapshot: firstAttachment.filename,
        contentType: firstAttachment.contentType,
      },
      {
        type: "file",
        fileId: secondAttachment.id,
        filenameSnapshot: secondAttachment.filename,
        contentType: secondAttachment.contentType,
      },
      templatePart("Pitch deck", {
        type: "presentation",
        selection: {
          templateId: "template:pitch-deck",
          colorSystemId: "color:launch",
        },
      }),
      { type: "text", text: "Opening paragraph\nSecond line " },
      {
        type: "chat_thread",
        threadId: CHAT_THREAD_ID,
        titleSnapshot: "Launch decisions",
      },
      { type: "text", text: " with " },
      {
        type: "agent",
        agentId: AGENT_ID,
        nameSnapshot: "Release Scout",
      },
      { type: "text", text: " closing notes." },
    ],
  };

  const saved = saveRestoredMessage(document, [
    firstAttachment,
    secondAttachment,
  ]);
  expect(saved).toStrictEqual(document);
  const prompt = messageDocumentToPrompt(saved);
  expect(prompt).not.toBeNull();
  expectTextOrder(prompt ?? "", [
    "Pitch deck",
    "Opening paragraph\nSecond line",
    "Launch decisions",
    "Release Scout",
    "closing notes.",
  ]);
});

test("Email feedback keeps its source status", () => {
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      {
        type: "feedback",
        quote: "The launch date is Thursday.",
        note: [{ type: "text", text: "Rewrite this for the customer." }],
        source: {
          type: "mail",
          id: "draft-mail-931",
          sentId: "sent-mail-931",
          status: "sent",
        },
      },
    ],
  };

  expect(saveRestoredMessage(document)).toStrictEqual(document);
  expect(messageDocumentToPrompt(document)).toBe(
    "The user quoted this part of a sent email (mail ID: draft-mail-931, sent ID: sent-mail-931):\n\n" +
      "> The launch date is Thursday.\n\n" +
      "Rewrite this for the customer.",
  );
});

test("Forwarded feedback uses the document-level source title", () => {
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      {
        type: "feedback",
        quote: "The deployment window is fifteen minutes.",
        note: [],
      },
      {
        type: "source",
        kind: "agent",
        runId: "d0000000-0000-4000-a000-000000000931",
        threadId: CHAT_THREAD_ID,
        agentId: AGENT_ID,
        titleSnapshot: "Source launch plan",
        href: `/chats/${CHAT_THREAD_ID}#run-d0000000-0000-4000-a000-000000000931`,
      },
    ],
  };
  const expected =
    'The user forwarded this from the chat "Source launch plan":\n\n' +
    "> The deployment window is fifteen minutes.";

  expect(messageDocumentToPrompt(document)).toBe(expected);
  expect(messageDocumentToDisplayText(document)).toBe(expected);
});

test("Forwarded mail feedback keeps common source identifiers", () => {
  const sourcePart = {
    type: "source",
    kind: "agent",
    runId: "d0000000-0000-4000-a000-000000000932",
    threadId: CHAT_THREAD_ID,
    agentId: AGENT_ID,
    titleSnapshot: "Source launch plan",
    href: `/chats/${CHAT_THREAD_ID}#run-d0000000-0000-4000-a000-000000000932`,
  } as const satisfies UserMessagePart;
  const cases: readonly {
    readonly document: UserMessageDocument;
    readonly expected: string;
  }[] = [
    {
      document: {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: "The draft launch date is Thursday.",
            note: [{ type: "text", text: "Please update this email draft." }],
            source: {
              type: "mail",
              id: "draft-mail-932",
              status: "draft",
            },
          },
          sourcePart,
        ],
      },
      expected:
        'The user forwarded this from the chat "Source launch plan":\n\n' +
        "Source: an email draft (mail draft ID: draft-mail-932)\n\n" +
        "> The draft launch date is Thursday.\n\n" +
        "Please update this email draft.",
    },
    {
      document: {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: "The sent launch date is Friday.",
            note: [],
            source: {
              type: "mail",
              id: "sent-mail-932",
              status: "sent",
              sentId: "gmail-sent-932",
            },
          },
          sourcePart,
        ],
      },
      expected:
        'The user forwarded this from the chat "Source launch plan":\n\n' +
        "Source: a sent email (mail ID: sent-mail-932, sent ID: gmail-sent-932)\n\n" +
        "> The sent launch date is Friday.",
    },
    {
      document: {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: "The first draft passage.",
            note: [],
            source: {
              type: "mail",
              id: "multi-mail-932",
              status: "draft",
            },
          },
          {
            type: "feedback",
            quote: "The second draft passage.",
            note: [{ type: "text", text: "Keep these passages together." }],
            source: {
              type: "mail",
              id: "multi-mail-932",
              status: "draft",
            },
          },
          sourcePart,
        ],
      },
      expected:
        'The user forwarded 2 parts from the chat "Source launch plan":\n\n' +
        "Source: an email draft (mail draft ID: multi-mail-932)\n\n" +
        "> The first draft passage.\n\n---\n\n" +
        "> The second draft passage.\n\n" +
        "Keep these passages together.",
    },
  ];

  for (const scenario of cases) {
    expect(messageDocumentToPrompt(scenario.document)).toBe(scenario.expected);
    expect(messageDocumentToDisplayText(scenario.document)).toBe(
      scenario.expected,
    );
  }
});

test("A file-only message keeps its attachment without invented text", () => {
  const attachment: PersistedAttachment = {
    id: "f0000000-0000-4000-a000-000000000933",
    url: "https://cdn.vm0.io/messages/file-one.pdf",
    filename: "file-one.pdf",
    contentType: "application/pdf",
    size: 1024,
  };
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      {
        type: "file",
        fileId: attachment.id,
        filenameSnapshot: attachment.filename,
        contentType: attachment.contentType,
      },
    ],
  };

  const saved = saveRestoredMessage(document, [attachment]);
  expect(saved).toStrictEqual(document);
  expect(
    saved.parts.some((part) => {
      return part.type === "text";
    }),
  ).toBeFalsy();
  expect(messageDocumentToPrompt(saved)).toBe("");
});

test("An annotated attachment keeps its editable marks on the file part", () => {
  const annotations = {
    marks: [
      {
        id: "mark-1",
        ordinal: 1,
        shape: "box" as const,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        ink: "#5E6AD2",
        note: "Fix this",
      },
    ],
  };
  const attachment: MessageDocumentAttachment = {
    id: "f0000000-0000-4000-a000-000000000934",
    url: "https://cdn.vm0.io/messages/layout.png",
    filename: "layout.png",
    contentType: "image/png",
    size: 1024,
    annotatedFileId: "f0000000-0000-4000-a000-000000000935",
    annotations,
  };
  const editor = createEditorSchema().nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph" }],
  });

  expect(
    editorDocToMessageDocument(editor, { attachments: [attachment] }),
  ).toStrictEqual({
    version: 1,
    parts: [
      {
        type: "file",
        fileId: attachment.id,
        filenameSnapshot: attachment.filename,
        contentType: attachment.contentType,
        annotatedFileId: attachment.annotatedFileId,
        annotations,
      },
    ],
  });
});

test("A malformed rich message is rejected safely", () => {
  const malformedDocuments: unknown[] = [
    {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "Unsupported source status",
          note: [],
          source: { type: "mail", id: "mail-931", status: "archived" },
        },
      ],
    },
    {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: "Incomplete template",
          template: { type: "presentation" },
        },
      ],
    },
    { version: 1, parts: [] },
  ];

  for (const malformed of malformedDocuments) {
    expect(messageDocumentToEditorDoc(malformed)).toBeNull();
    expect(messageDocumentToPrompt(malformed)).toBeNull();
  }

  const mismatchedTemplate = createEditorSchema().nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "templateAttachment",
        attrs: { templateType: "presentation", title: "Pitch deck" },
      },
    ],
  });
  expect(
    editorDocToMessageDocument(mismatchedTemplate, {
      selectedTemplate: {
        type: "illustration",
        selection: { illustrationStyleId: "paper-cut" },
      },
    }),
  ).toBeNull();

  const emptyEditor = createEditorSchema().nodeFromJSON({ type: "doc" });
  expect(editorDocToMessageDocument(emptyEditor)).toBeNull();
});

test("Multiple feedback quotes keep their notes and order", () => {
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      { type: "text", text: "Context before feedback." },
      {
        type: "feedback",
        quote: "First quoted passage",
        note: [{ type: "text", text: "Tighten the first point." }],
        eventId: "assistant-event-1",
        range: { start: 4, end: 25 },
      },
      {
        type: "feedback",
        quote: "Second quoted passage",
        note: [
          { type: "text", text: "Compare this with\n" },
          {
            type: "chat_thread",
            threadId: CHAT_THREAD_ID,
            titleSnapshot: "Launch decisions",
          },
        ],
        eventId: "assistant-event-2",
        range: { start: 30, end: 52 },
      },
      { type: "text", text: "Context after feedback." },
    ],
  };

  expect(saveRestoredMessage(document)).toStrictEqual(document);
  const prompt = messageDocumentToPrompt(document);
  expect(prompt).not.toBeNull();
  expectTextOrder(prompt ?? "", [
    "Context before feedback.",
    "First quoted passage",
    "Tighten the first point.",
    "---",
    "Second quoted passage",
    "Compare this with\n",
    "Launch decisions",
    "Context after feedback.",
  ]);
});

test("Multiple inline templates survive feedback editing", () => {
  const pitchDeck = templatePart("Pitch deck", {
    type: "presentation",
    selection: { templateId: "template:pitch-deck" },
  });
  const paperCut = templatePart("Paper cut", {
    type: "illustration",
    selection: { illustrationStyleId: "paper-cut" },
  });
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      { type: "text", text: "Build " },
      pitchDeck,
      { type: "text", text: " and illustrate with " },
      paperCut,
      { type: "text", text: "." },
      {
        type: "feedback",
        quote: "Make the diagram clearer.",
        note: [
          { type: "text", text: "Use " },
          paperCut,
          { type: "text", text: " for this passage." },
        ],
      },
    ],
  };

  expect(saveRestoredMessage(document)).toStrictEqual(document);
  const prompt = messageDocumentToPrompt(document);
  expect(prompt).not.toBeNull();
  expectTextOrder(prompt ?? "", [
    "Pitch deck presentation template",
    "Paper cut illustration template",
    "Make the diagram clearer.",
    "Paper cut illustration template",
  ]);
});

test("Paragraphs, line breaks, and intentional spaces are preserved", () => {
  const authoredEditor = createEditorSchema().nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "  Leading spaces" },
          { type: "hardBreak" },
          { type: "text", text: "hard break with trailing spaces  " },
        ],
      },
      { type: "paragraph" },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Final paragraph  " }],
      },
    ],
  });
  const expectedText =
    "  Leading spaces\nhard break with trailing spaces  \n\nFinal paragraph  ";

  const saved = editorDocToMessageDocument(authoredEditor);
  expect(saved).toStrictEqual({
    version: 1,
    parts: [{ type: "text", text: expectedText }],
  });
  if (!saved) {
    throw new Error("Multiline user message was not saved");
  }
  expect(saveRestoredMessage(saved)).toStrictEqual(saved);
});

test("A single quoted passage without a note stays singular", () => {
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      {
        type: "feedback",
        quote: "Reference only",
        note: [],
      },
    ],
  };

  expect(messageDocumentToPrompt(document)).toBe(
    "The user quoted this part of your reply:\n\n> Reference only",
  );
});

test("Multiple quoted passages can mix notes and references", () => {
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      {
        type: "feedback",
        quote: "First referenced passage",
        note: [{ type: "text", text: "Keep the evidence concise." }],
      },
      {
        type: "feedback",
        quote: "Second reference only",
        note: [],
        eventId: "assistant-event-quote-only",
        range: { start: 60, end: 81 },
      },
    ],
  };

  expect(saveRestoredMessage(document)).toStrictEqual(document);
  expect(messageDocumentToPrompt(document)).toBe(
    "The user quoted 2 parts of your reply:\n\n" +
      "> First referenced passage\n\n" +
      "Keep the evidence concise.\n\n" +
      "---\n\n" +
      "> Second reference only",
  );
});

test("Routing metadata is not shown as user text", () => {
  const metadataParts: UserMessagePart[] = [
    { type: "source", kind: "slack", href: "https://slack.com/message/931" },
    {
      type: "automation",
      workflowName: "Release workflow",
      automationBrief: "Internal automation routing",
    },
    { type: "goal", goalBrief: "Internal rollout goal" },
    {
      type: "automation",
      workflowName: "Morning Brief",
      automationBrief: "Internal morning-brief routing",
    },
    {
      type: "model",
      selectedModel: "claude-sonnet-4-6",
      serviceTier: "priority",
    },
  ];

  for (const metadata of metadataParts) {
    const parsed = userMessageDocumentSchema.parse({
      version: 1,
      parts: [{ type: "text", text: "Keep this text" }, metadata],
    });
    expect(parsed.parts[1]).toStrictEqual(metadata);
    expect(messageDocumentToDisplayText(parsed)).toBe("Keep this text");
    expect(messageDocumentToPrompt(parsed)).toBe("Keep this text");
  }
});

test("A template-only message remains sendable", () => {
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      templatePart("Pitch deck", {
        type: "presentation",
        selection: { templateId: "template:pitch-deck" },
      }),
    ],
  };

  const saved = saveRestoredMessage(document);
  expect(saved).toStrictEqual(document);
  expect(messageDocumentToPrompt(saved)).toBe(
    "Select Pitch deck presentation template",
  );
});

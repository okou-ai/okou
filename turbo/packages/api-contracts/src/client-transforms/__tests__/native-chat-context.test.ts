import { describe, expect, it } from "vitest";
import { fromJSONSchema, type core } from "zod";
import {
  iosChatContextTransforms,
  androidChatContextTransforms,
} from "../native-chat-context";
import previousRowsJsonSchema from "./fixtures/email-chat-rows-2026-11-09.json";
import previousCatchUpJsonSchema from "./fixtures/email-chat-catch-up-2026-11-09.json";

// Pinned production response schemas: runtime-api-schema-prod/current.json,
// GitHub release asset 726176899, retrieved 2026-11-09 before adding Email.
const threadId = "00000000-0000-4000-8000-000000000001";
const emailRow = {
  id: "00000000-0000-4000-8000-000000000002",
  chatThreadId: threadId,
  runId: null,
  revokesEventId: null,
  contextType: "email",
  contextId: "email-context",
  runEventSequenceNumber: null,
  runEventId: null,
  seqId: 1,
  createdAt: "2026-11-09T00:00:00.000Z",
  eventType: "input.prompt",
  payload: {
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "Original email request" }],
    },
  },
};
const webRow = {
  ...emailRow,
  id: "00000000-0000-4000-8000-000000000003",
  seqId: 2,
  contextType: "web",
  contextId: "existing-web-context",
};
const legacyEmailRow = { ...emailRow, contextType: "web", contextId: null };

describe.each([
  {
    name: "raw event rows",
    transform: iosChatContextTransforms.rows,
    previousSchema: previousRowsJsonSchema,
    current: {
      rows: [emailRow, webRow],
      cursor: { lastEventId: webRow.id, lastSeqId: 2 },
      hasMore: false,
    },
    expected: {
      rows: [legacyEmailRow, webRow],
      cursor: { lastEventId: webRow.id, lastSeqId: 2 },
      hasMore: false,
    },
  },
  {
    name: "batch event catch-up",
    transform: iosChatContextTransforms.catchUp,
    previousSchema: previousCatchUpJsonSchema,
    current: {
      events: { [threadId]: [emailRow, webRow] },
      notFoundThreads: [],
    },
    expected: {
      events: { [threadId]: [legacyEmailRow, webRow] },
      notFoundThreads: [],
    },
  },
])(
  "iOS Email compatibility: $name",
  ({ transform, previousSchema, current, expected }) => {
    it("keeps the response readable by the production reader without losing email content or unrelated context", () => {
      const previous = fromJSONSchema(
        previousSchema as core.JSONSchema.JSONSchema,
      );
      expect(previous.safeParse(current).success).toBeFalsy();
      const transformed = transform.transform(current);
      expect(previous.safeParse(transformed).success).toBeTruthy();
      expect(transformed).toStrictEqual(expected);
    });
  },
);

describe.each([iosChatContextTransforms, androidChatContextTransforms])(
  "native proactive history",
  ({ rows, catchUp }) => {
    it("projects both history routes to a readable prompt and preserves the occurrence contents, cursor and other rows", () => {
      const proactive = {
        ...emailRow,
        contextType: "proactive",
        contextId: emailRow.id,
      };
      const projected = { ...proactive, contextType: "web", contextId: null };
      const currentRows = {
        rows: [proactive, webRow],
        cursor: { lastEventId: webRow.id, lastSeqId: 2 },
        hasMore: false,
      };
      const currentCatchUp = {
        events: { [threadId]: [proactive, webRow] },
        notFoundThreads: [],
      };
      for (const [transform, previousSchema, current, expected] of [
        [
          rows,
          previousRowsJsonSchema,
          currentRows,
          { ...currentRows, rows: [projected, webRow] },
        ],
        [
          catchUp,
          previousCatchUpJsonSchema,
          currentCatchUp,
          { ...currentCatchUp, events: { [threadId]: [projected, webRow] } },
        ],
      ] as const) {
        const previous = fromJSONSchema(
          previousSchema as core.JSONSchema.JSONSchema,
        );
        expect(previous.safeParse(current).success).toBeFalsy();
        const result = transform.transform(current);
        expect(previous.safeParse(result).success).toBeTruthy();
        expect(result).toStrictEqual(expected);
      }
    });
  },
);

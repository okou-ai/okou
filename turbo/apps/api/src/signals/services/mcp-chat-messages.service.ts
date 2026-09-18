import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import {
  groupSemanticChatEvents,
  semanticChatEventsFromChatEvents,
} from "@okouai/api-contracts/contracts/chat-event-semantics";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type {
  McpChatMessage,
  McpGetChatMessagesInput,
  McpGetChatMessagesOutput,
  McpMessageReadResult,
} from "@okouai/api-contracts/contracts/mcp-chat-messages";
import { computed, type Computed } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import type { Db } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import { projectUserMessage } from "./chat-user-message.service";
import {
  McpMessageHistoryError,
  readMcpChatMessageHistory,
} from "./mcp-chat-message-history.service";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

type CompleteMessage = Omit<
  McpChatMessage,
  | "textOffset"
  | "textComplete"
  | "fileOffset"
  | "filesComplete"
  | "nextContentCursor"
>;
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const TEXT_UNITS = 8192;
const FILES_PER_SEGMENT = 8;
const SEGMENT_BYTES = 64 * 1024;
// The SDK sends both structuredContent and its JSON text rendering. Reserve
// enough space for their duplication and JSON escaping within a 512 KiB result.
const OUTPUT_BYTES = 160 * 1024;
const cursorSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string(),
  orgId: z.string(),
  filters: z.string(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  digest: z.string(),
  position: z.number().int().nonnegative(),
  mode: z.enum(["older", "newer", "content"]),
  eventId: z.string().optional(),
  textOffset: z.number().int().nonnegative().optional(),
  fileOffset: z.number().int().nonnegative().optional(),
});
type Cursor = z.infer<typeof cursorSchema>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function signCursor(payload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update("mcp:get_chat_messages:v1\n")
    .update(payload)
    .digest();
}

function encodeCursor(cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
  const token = `${payload}.${signCursor(payload).toString("base64url")}`;
  if (token.length > 4096) {
    throw new McpMessageHistoryError(
      "history_limit",
      "Message identity metadata exceeds the supported continuation size.",
    );
  }
  return token;
}

function decodeCursor(
  token: string,
  principal: Principal,
  filters: string,
): Cursor | null {
  const [payload, signature, extra] = token.split(".");
  if (
    !payload ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(payload) ||
    !/^[A-Za-z0-9_-]+$/u.test(signature)
  ) {
    return null;
  }
  const actual = Buffer.from(signature, "base64url");
  const expected = signCursor(payload);
  if (
    actual.toString("base64url") !== signature ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return null;
  }
  const parsed = cursorSchema.safeParse(
    safeJsonParse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  if (!parsed.success) {
    return null;
  }
  const cursor = parsed.data;
  return cursor.userId === principal.userId &&
    cursor.orgId === principal.orgId &&
    cursor.filters === filters &&
    cursor.issuedAt <= now() &&
    cursor.expiresAt > now() &&
    cursor.expiresAt - cursor.issuedAt === CURSOR_TTL_MS
    ? cursor
    : null;
}

export function projectMcpChatMessages(
  rows: readonly ChatEventRow[],
  checkBudget: () => void,
): CompleteMessage[] {
  const events = rows.map((row) => {
    checkBudget();
    return chatEventFromRow(row);
  });
  const groups = groupSemanticChatEvents(
    semanticChatEventsFromChatEvents(events),
  );
  const messages: CompleteMessage[] = [];
  for (const group of groups.allGroups) {
    for (const state of group.events) {
      checkBudget();
      const event = state.event;
      if (
        event.eventType !== "input.prompt" &&
        event.eventType !== "input.rejected" &&
        event.eventType !== "output.message"
      ) {
        continue;
      }
      const userMessage =
        event.eventType === "output.message" ? undefined : event.userMessage;
      messages.push({
        ref: {
          threadId: event.threadId,
          eventId: event.id,
          seqId: event.seqId,
        },
        role: event.eventType === "output.message" ? "assistant" : "user",
        eventType: event.eventType,
        createdAt: state.inputCreatedAt ?? event.createdAt,
        runId: event.runId ?? null,
        text:
          event.eventType === "output.message"
            ? event.content
            : projectUserMessage(event.userMessage).displayText,
        files:
          userMessage?.parts.flatMap((part) => {
            return part.type === "file"
              ? [
                  {
                    fileId: part.fileId,
                    filename: part.filenameSnapshot,
                    contentType: part.contentType,
                    ...(part.annotatedFileId
                      ? { annotatedFileId: part.annotatedFileId }
                      : {}),
                  },
                ]
              : [];
          }) ?? [],
        url: new URL(`/chats/${event.threadId}`, env("APP_URL")).toString(),
      });
    }
  }
  checkBudget();
  return messages;
}

function segment(
  message: CompleteMessage,
  base: Cursor,
  textOffset = 0,
  fileOffset = 0,
): McpChatMessage {
  let end = Math.min(message.text.length, textOffset + TEXT_UNITS);
  // Do not split a UTF-16 surrogate pair. Offsets use JS string.slice units.
  if (
    end < message.text.length &&
    /[\uD800-\uDBFF]/u.test(message.text.charAt(end - 1))
  ) {
    end -= 1;
  }
  const files = message.files.slice(fileOffset, fileOffset + FILES_PER_SEGMENT);
  const messageDigest = digest(message);
  for (;;) {
    const textComplete = end === message.text.length;
    const filesComplete = fileOffset + files.length === message.files.length;
    const result: McpChatMessage = {
      ...message,
      text: message.text.slice(textOffset, end),
      files,
      textOffset,
      textComplete,
      fileOffset,
      filesComplete,
      nextContentCursor:
        textComplete && filesComplete
          ? null
          : encodeCursor({
              ...base,
              mode: "content",
              digest: messageDigest,
              eventId: message.ref.eventId,
              textOffset: end,
              fileOffset: fileOffset + files.length,
            }),
    };
    if (Buffer.byteLength(JSON.stringify(result)) <= SEGMENT_BYTES) {
      return result;
    }
    if (files.length > 1) {
      files.pop();
      continue;
    }
    if (files.length > 0 && end > textOffset) {
      // A file can fit by itself even when its metadata and this text segment
      // cannot. Deliver the file now and keep the text offset for continuation.
      end = textOffset;
      continue;
    }
    throw new McpMessageHistoryError(
      "history_limit",
      "Message metadata exceeds the supported response size. No message content has been silently omitted.",
    );
  }
}

function readContent(
  messages: readonly CompleteMessage[],
  cursor: Cursor,
  base: Cursor,
): McpMessageReadResult {
  const target = messages.find((message) => {
    return message.ref.eventId === cursor.eventId;
  });
  if (!target || digest(target) !== cursor.digest) {
    return {
      kind: "view_changed",
      message:
        "The message changed or is no longer visible. Read it again without this content cursor.",
    };
  }
  if (
    cursor.textOffset === undefined ||
    cursor.fileOffset === undefined ||
    cursor.textOffset > target.text.length ||
    cursor.fileOffset > target.files.length
  ) {
    return {
      kind: "invalid_cursor",
      message: "Invalid content cursor. Read the message again.",
    };
  }
  return {
    kind: "ok",
    data: {
      messages: [segment(target, base, cursor.textOffset, cursor.fileOffset)],
      olderCursor: null,
      newerCursor: null,
    },
  };
}

interface MessageWindow {
  readonly start: number;
  readonly end: number;
  readonly positions: readonly number[];
}

function messageWindow(
  messages: readonly CompleteMessage[],
  input: McpGetChatMessagesInput,
  cursor: Cursor | null,
): MessageWindow | Exclude<McpMessageReadResult, { kind: "ok" }> {
  let start = Math.max(0, messages.length - input.limit);
  let end = messages.length;
  let anchorIndex: number | undefined;
  if (cursor) {
    if (cursor.position > messages.length) {
      return {
        kind: "invalid_cursor",
        message: "Invalid history cursor. Restart without cursor.",
      };
    }
    start =
      cursor.mode === "older"
        ? Math.max(0, cursor.position - input.limit)
        : cursor.position;
    end =
      cursor.mode === "older"
        ? cursor.position
        : Math.min(messages.length, start + input.limit);
  } else if (input.around) {
    const anchor = input.around;
    const index = messages.findIndex((message) => {
      return (
        (anchor.eventId === undefined ||
          message.ref.eventId === anchor.eventId) &&
        (anchor.seqId === undefined || message.ref.seqId === anchor.seqId)
      );
    });
    if (index === -1) {
      return {
        kind: "reference_unavailable",
        message:
          "The reference is absent, replaced, hidden, or outside this run filter. Find a current visible message reference.",
      };
    }
    start = Math.max(0, index - Math.floor((input.limit - 1) / 2));
    end = Math.min(messages.length, start + input.limit);
    anchorIndex = index;
  }
  const backwards = cursor?.mode !== "newer" && !input.around;
  const positions = Array.from({ length: end - start }, (_, offset) => {
    return backwards ? end - offset - 1 : start + offset;
  });
  if (anchorIndex !== undefined) {
    const anchor = anchorIndex;
    // Start at the requested message and expand in either direction. A byte
    // bound can reduce context, but cannot remove the requested anchor.
    positions.sort((left, right) => {
      return Math.abs(left - anchor) - Math.abs(right - anchor) || left - right;
    });
  }
  return { start, end, positions };
}

function readPage(
  messages: readonly CompleteMessage[],
  input: McpGetChatMessagesInput,
  cursor: Cursor | null,
  context: {
    readonly principal: Principal;
    readonly filters: string;
    readonly checkBudget: () => void;
  },
): McpMessageReadResult {
  const { principal, filters, checkBudget } = context;
  const issuedAt = cursor?.issuedAt ?? now();
  const base: Cursor = {
    version: 1,
    userId: principal.userId,
    orgId: principal.orgId,
    filters,
    issuedAt,
    expiresAt: issuedAt + CURSOR_TTL_MS,
    mode: "older",
    digest: "",
    position: 0,
  };
  if (cursor?.mode === "content") {
    return readContent(messages, cursor, base);
  }
  const transcript = createHash("sha256");
  for (const message of messages) {
    checkBudget();
    transcript.update(digest(message));
  }
  base.digest = transcript.digest("hex");
  if (cursor && cursor.digest !== base.digest) {
    return {
      kind: "view_changed",
      message:
        "Visible conversation history changed. Restart without cursor; use around with a still-visible reference to resume near that message.",
    };
  }
  const window = messageWindow(messages, input, cursor);
  if ("kind" in window) {
    return window;
  }
  const page: { position: number; message: McpChatMessage }[] = [];
  // Every partial segment carries an independently usable continuation.
  let pageBytes = 0;
  for (const position of window.positions) {
    checkBudget();
    const message = messages[position];
    if (!message) {
      throw new Error("Message page position is invalid");
    }
    const part = segment(message, base);
    const bytes = Buffer.byteLength(JSON.stringify(part));
    if (page.length && pageBytes + bytes > OUTPUT_BYTES - 8192) {
      break;
    }
    page.push({ position, message: part });
    pageBytes += bytes;
  }
  page.sort((left, right) => {
    return left.position - right.position;
  });
  const start = page.at(0)?.position ?? window.start;
  const last = page.at(-1);
  const end = last ? last.position + 1 : start;
  const data: McpGetChatMessagesOutput = {
    messages: page.map((entry) => {
      return entry.message;
    }),
    olderCursor:
      start > 0
        ? encodeCursor({ ...base, mode: "older", position: start })
        : null,
    newerCursor:
      end < messages.length
        ? encodeCursor({ ...base, mode: "newer", position: end })
        : null,
  };
  if (Buffer.byteLength(JSON.stringify(data)) > OUTPUT_BYTES) {
    throw new McpMessageHistoryError(
      "history_limit",
      "The message response exceeds its supported byte limit.",
    );
  }
  return { kind: "ok", data };
}

export function getMcpChatMessages(
  runtime: { readonly db: Db; readonly bucket: string },
  principal: Principal,
  input: McpGetChatMessagesInput,
  signal: AbortSignal,
): Computed<Promise<McpMessageReadResult>> {
  return computed(async (get): Promise<McpMessageReadResult> => {
    const startedAt = performance.now();
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const checkBudget = () => {
      signal.throwIfAborted();
      if (operationSignal.aborted || performance.now() - startedAt >= 15_000) {
        throw new McpMessageHistoryError(
          "history_limit",
          "Conversation history exceeded the 15-second read budget. Retry later; a smaller page does not reduce reconstruction work.",
        );
      }
    };
    const filters = digest({
      threadId: input.threadId,
      runId: input.runId ?? null,
      limit: input.limit,
    });
    const cursor = input.cursor
      ? decodeCursor(input.cursor, principal, filters)
      : null;
    if (input.cursor && !cursor) {
      return {
        kind: "invalid_cursor",
        message:
          "The message cursor is invalid, expired, or belongs to different authorization, thread, run filter or limit. Restart without cursor.",
      };
    }
    const result = await settle(
      (async (): Promise<McpMessageReadResult> => {
        const rows = await get(
          readMcpChatMessageHistory(
            runtime,
            principal,
            input.threadId,
            operationSignal,
          ),
        );
        checkBudget();
        if (rows === null) {
          return { kind: "not_found", message: "Conversation not found." };
        }
        const messages = projectMcpChatMessages(rows, checkBudget).filter(
          (message) => {
            return input.runId === undefined || message.runId === input.runId;
          },
        );
        const page = readPage(messages, input, cursor, {
          principal,
          filters,
          checkBudget,
        });
        checkBudget();
        return page;
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (operationSignal.aborted || performance.now() - startedAt >= 15_000) {
      return {
        kind: "history_limit",
        message:
          "Conversation history exceeded the 15-second read budget. Retry later; a smaller page does not reduce reconstruction work.",
      };
    }
    if (result.ok) {
      return result.value;
    }
    if (result.error instanceof McpMessageHistoryError) {
      return { kind: result.error.kind, message: result.error.message };
    }
    return {
      kind: "history_unavailable",
      message:
        "Conversation history is temporarily unavailable or its archive could not be verified. Retry later.",
    };
  });
}

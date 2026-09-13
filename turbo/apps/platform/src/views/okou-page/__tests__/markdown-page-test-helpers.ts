import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";

import {
  chatEventRowsResponse,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";

const MARKDOWN_AGENT_ID = "c0000000-0000-4000-a000-000000000071";

const CREATED_AT = "2026-08-10T12:00:00.000Z";

interface OutputRowOptions {
  readonly id?: string;
  readonly runEventId?: string;
  readonly runId?: string;
  readonly seqId: number;
  readonly sequenceNumber?: number;
}

interface InstallMarkdownChatOptions {
  readonly onRowsRequest?: (sinceSeqId: number) => void;
  readonly rows: () => readonly ChatEventRow[];
}

export interface MarkdownChatFixture {
  readonly path: string;
  readonly realtimeTopic: string;
  readonly threadId: string;
  readonly install: (options: InstallMarkdownChatOptions) => void;
  readonly outputError: (
    error: string,
    options: OutputRowOptions,
  ) => ChatEventRow;
  readonly outputMessage: (
    content: string,
    options: OutputRowOptions,
  ) => ChatEventRow;
  readonly runCompleted: (options: OutputRowOptions) => ChatEventRow;
}

function rowBase(threadId: string, options: OutputRowOptions) {
  const runId = options.runId ?? "markdown-run";
  return {
    id: options.id ?? `markdown-event-${options.seqId}`,
    chatThreadId: threadId,
    runId,
    revokesEventId: null,
    contextType: null,
    contextId: null,
    runEventSequenceNumber: options.sequenceNumber ?? options.seqId,
    runEventId: options.runEventId ?? `${runId}-event-${options.seqId}`,
    seqId: options.seqId,
    createdAt: CREATED_AT,
  };
}

export function createMarkdownChatFixture(
  context: TestContext,
): MarkdownChatFixture {
  const threadId = context.resourceId;

  return {
    threadId,
    path: `/chats/${threadId}`,
    realtimeTopic: `chatThreadMessageCreated:${threadId}`,
    outputMessage: (content, options) => {
      return {
        ...rowBase(threadId, options),
        eventType: "output.message",
        payload: { content },
      };
    },
    outputError: (error, options) => {
      return {
        ...rowBase(threadId, options),
        eventType: "output.error",
        payload: { error },
      };
    },
    runCompleted: (options) => {
      return {
        ...rowBase(threadId, options),
        eventType: "run.completed",
        payload: null,
      };
    },
    install: ({ rows, onRowsRequest }) => {
      context.mocks.data.agents([
        {
          agentId: MARKDOWN_AGENT_ID,
          displayName: "Markdown Agent",
        },
      ]);
      context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
        return respond(200, {
          chatThreads: [
            {
              id: threadId,
              agentId: MARKDOWN_AGENT_ID,
              title: "Rich content",
              sortAt: CREATED_AT,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
              pinnedAt: null,
              renamedAt: null,
              selectedModel: "claude-sonnet-4-6",
              serviceTier: null,
              computerUseHostId: null,
              cloudBrowserEnabled: false,
              selectedVideoModel: null,
              selectedImageModel: null,
            },
          ],
          latestEventId: null,
          latestSeqId: null,
        });
      });
      context.mocks.api(chatThreadsContract.events, ({ respond }) => {
        return respond(200, { events: [], hasMore: false });
      });
      context.mocks.api(
        chatThreadMetadataContract.get,
        ({ params, respond }) => {
          return respond(200, {
            id: params.id,
            agentId: MARKDOWN_AGENT_ID,
            title: "Rich content",
            selectedModel: "claude-sonnet-4-6",
            modelSettings: {},
            serviceTier: null,
            pinnedAt: null,
            computerUseHostId: null,
            cloudBrowserEnabled: false,
            selectedVideoModel: null,
            selectedImageModel: null,
          });
        },
      );
      context.mocks.api(
        chatThreadEventsContract.rows,
        ({ params, query, respond }) => {
          onRowsRequest?.(query.sinceSeqId);
          const availableRows = rows().filter((row) => {
            return (
              row.chatThreadId === params.threadId &&
              row.seqId > query.sinceSeqId
            );
          });
          return respond(200, chatEventRowsResponse(availableRows, query));
        },
      );
      context.mocks.api(browserContract.get, ({ respond }) => {
        return respond(404, {
          error: {
            code: "BROWSER_NOT_FOUND",
            message: "Browser session not found",
          },
        });
      });
    },
  };
}

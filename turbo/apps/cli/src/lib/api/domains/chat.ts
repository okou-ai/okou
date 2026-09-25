import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  type ChatEventSendBody,
  chatEventsContract,
  chatThreadArchiveContract,
  chatThreadEventsContract,
  chatThreadsContract,
  chatThreadSnapshotArchiveSchema,
  emptyChatThreadSnapshot,
  type ChatThreadEvent as ApiChatThreadEvent,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  chatSearchContract,
  type ChatThreadServiceTier,
  type ChatThreadMetadata,
  type ChatThreadSnapshotProjection,
  type Indicators,
  type ChatSearchResponse,
} from "@okouai/api-contracts/contracts/chat-threads";
import { isSupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { getClientConfig, handleError } from "../core/client-factory";

export interface ChatThreadSnapshot {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

export type ChatThreadEvent = ApiChatThreadEvent;

type ChatEventSnapshotResult =
  | {
      readonly kind: "snapshot";
      readonly url: string;
      readonly lastEventId: string | null;
      readonly lastSeqId: number;
    }
  | { readonly kind: "missing" };

type ChatEventRowsPage =
  | {
      readonly kind: "rows";
      readonly rows: readonly ChatEventRow[];
      readonly cursor: ChatEventCursor;
      readonly hasMore: boolean;
    }
  | { readonly kind: "expired" };

type ChatEventSchemaVersionHeaders = Readonly<{
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]: string;
}>;

const CHAT_EVENT_SCHEMA_VERSION_HEADERS: ChatEventSchemaVersionHeaders =
  Object.freeze({
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
  });

function assertChatEventSchemaVersion(headers: Headers): void {
  const version = headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
  if (version !== CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()) {
    throw new Error(`Unexpected Chat Event schema version ${version}`);
  }
}

function requireSupportedModel(model: string) {
  if (!isSupportedRunModel(model)) {
    throw new Error(`Unsupported chat model: ${model}`);
  }
  return model;
}

interface ChatThreadCreateResult {
  readonly threadId: string;
  readonly title: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
}

interface ChatEventSendResult {
  readonly runId: string | null;
  readonly threadId: string;
  readonly status?: string;
  readonly createdAt?: string;
}

type ChatThreadEventsResult =
  | {
      readonly kind: "page";
      readonly events: readonly ChatThreadEvent[];
      readonly hasMore: boolean;
    }
  | { readonly kind: "expired" };

export async function searchChat(options: {
  keyword: string;
  agentId?: string;
  since?: number;
}): Promise<ChatSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(chatSearchContract, config);
  const result = await client.search({
    query: {
      keyword: options.keyword,
      agentId: options.agentId,
      since: options.since,
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to search chat messages");
}

export async function getChatThreadSnapshot(): Promise<ChatThreadSnapshot> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.snapshot();
  if (result.status === 200) {
    if (!("url" in result.body)) {
      return emptyChatThreadSnapshot(result.body);
    }
    const response = await fetch(result.body.url);
    if (!response.ok) {
      throw new Error(
        `Failed to download chat thread snapshot: ${response.status.toString()}`,
      );
    }
    const archive = chatThreadSnapshotArchiveSchema.parse(
      await response.json(),
    );
    return {
      chatThreads: archive.chatThreads,
      latestEventId: result.body.latestEventId,
      latestSeqId: result.body.latestSeqId,
    };
  }
  handleError(result, "Failed to get chat thread snapshot");
}

export async function listChatThreadEvents(options: {
  sinceSeqId?: number;
}): Promise<ChatThreadEventsResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.events({
    query:
      options.sinceSeqId === undefined
        ? {}
        : { sinceSeqId: options.sinceSeqId },
  });
  if (result.status === 200) {
    return {
      kind: "page",
      events: result.body.events,
      hasMore: result.body.hasMore,
    };
  }
  if (result.status === 410) {
    return { kind: "expired" };
  }
  handleError(result, "Failed to list chat thread events");
}

export async function getChatIndicators(): Promise<Indicators> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.indicators();
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to get chat indicators");
}

export async function createChatThread(options: {
  agentId: string;
  title: string;
  model?: string;
  serviceTier?: ChatThreadServiceTier | null;
  reasoningEffort?: ReasoningEffort;
}): Promise<ChatThreadCreateResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.create({
    body: {
      agentId: options.agentId,
      title: options.title,
      ...(options.model === undefined
        ? {}
        : { model: requireSupportedModel(options.model) }),
      ...(options.serviceTier === undefined
        ? {}
        : { serviceTier: options.serviceTier }),
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
    },
  });
  if (result.status === 201) {
    return {
      threadId: result.body.id,
      title: result.body.title,
      selectedModel: result.body.selectedModel,
      serviceTier: result.body.serviceTier,
    };
  }
  handleError(result, "Failed to create chat thread");
}

export async function renameChatThread(options: {
  threadId: string;
  title: string;
}): Promise<{ threadId: string; title: string }> {
  const config = await getClientConfig();
  const client = initClient(chatThreadRenameContract, config);
  const result = await client.rename({
    params: { id: options.threadId },
    body: { title: options.title },
  });
  if (result.status === 204) {
    return { threadId: options.threadId, title: options.title };
  }
  handleError(result, "Failed to rename chat thread");
}

export async function setChatThreadArchived(options: {
  threadId: string;
  archived: boolean;
}): Promise<{ threadId: string; archived: boolean }> {
  const config = await getClientConfig();
  const client = initClient(chatThreadArchiveContract, config);
  const request = { params: { id: options.threadId } };
  const result = options.archived
    ? await client.archive(request)
    : await client.unarchive(request);
  if (result.status === 204) {
    return { threadId: options.threadId, archived: options.archived };
  }
  handleError(
    result,
    options.archived
      ? "Failed to archive chat thread"
      : "Failed to unarchive chat thread",
  );
}

export async function getChatThread(options: {
  threadId: string;
}): Promise<ChatThreadMetadata> {
  const config = await getClientConfig();
  const client = initClient(chatThreadMetadataContract, config);
  const result = await client.get({
    params: { id: options.threadId },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to get chat thread");
}

export async function getChatThreadAgentId(options: {
  threadId: string;
}): Promise<string> {
  const thread = await getChatThread(options);
  return thread.agentId;
}

export async function sendChatEvent(
  body: ChatEventSendBody,
): Promise<ChatEventSendResult> {
  const config = await getClientConfig();
  const client = initClient(chatEventsContract, config);
  const result = await client.send({ body });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to send chat event");
}

export async function getChatEventSnapshot(options: {
  readonly threadId: string;
}): Promise<ChatEventSnapshotResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadEventsContract, config);
  const result = await client.snapshot({
    headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
    params: { threadId: options.threadId },
  });
  assertChatEventSchemaVersion(result.headers);
  if (result.status === 200) {
    return {
      kind: "snapshot",
      url: result.body.url,
      lastEventId: result.body.lastEventId,
      lastSeqId: result.body.lastSeqId,
    };
  }
  if (result.status === 404) {
    return { kind: "missing" };
  }
  handleError(result, "Failed to get chat event snapshot");
}

export async function listChatEventRows(
  options: {
    readonly threadId: string;
    readonly limit: number;
  } & (
    | { readonly sinceEventId: null; readonly sinceSeqId: 0 }
    | {
        readonly sinceEventId: string;
        readonly sinceSeqId: number;
      }
  ),
): Promise<ChatEventRowsPage> {
  const config = await getClientConfig();
  const client = initClient(chatThreadEventsContract, config);
  const result = await client.rows({
    headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
    params: { threadId: options.threadId },
    query:
      options.sinceEventId === null
        ? { sinceSeqId: 0, limit: options.limit }
        : {
            sinceSeqId: options.sinceSeqId,
            sinceEventId: options.sinceEventId,
            limit: options.limit,
          },
  });
  assertChatEventSchemaVersion(result.headers);
  if (result.status === 200) {
    return {
      kind: "rows",
      rows: result.body.rows,
      cursor: result.body.cursor,
      hasMore: result.body.hasMore,
    };
  }
  if (result.status === 410) {
    return { kind: "expired" };
  }
  handleError(result, "Failed to list chat event rows");
}

export async function updateChatThreadModelSelection(options: {
  threadId: string;
  model: string | null;
  reasoningEffort?: ReasoningEffort;
}): Promise<{ threadId: string; selectedModel: string | null }> {
  const config = await getClientConfig();
  const client = initClient(chatThreadModelSelectionContract, config);
  const model =
    options.model === null ? null : requireSupportedModel(options.model);
  const result = await client.update({
    params: { id: options.threadId },
    body: {
      model,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
    },
  });
  if (result.status === 204) {
    return {
      threadId: options.threadId,
      selectedModel: model,
    };
  }
  handleError(result, "Failed to update chat thread model");
}

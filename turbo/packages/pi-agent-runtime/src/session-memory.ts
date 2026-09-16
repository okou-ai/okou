import { randomUUID } from "node:crypto";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  ModelThinkingLevel,
  StreamFunction,
  Tool,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import { parseValidatedPiSessionJsonl } from "./session-validation";
import {
  projectPiMemoryCitationSegments,
  visiblePiMemoryCitationText,
} from "@okouai/api-contracts/contracts/pi-memory-citations";
import type { PiApiFirstTurnOwnership } from "./provider-ownership";
import type { PiAgentStreamOptions } from "./stream-options";
import { PiApiModelRequestError } from "./api-failure";
import {
  measurePiPreparationSync,
  type PiPreparationObserver,
} from "./preparation-timing";

interface CreateMemoryPiSessionOptions {
  readonly cwd: string;
  readonly id: string;
  readonly parentSession?: string;
  readonly timestamp?: string;
}

interface RunPiFirstModelTurnOptions<TApi extends Api = Api> {
  readonly model: Model<TApi>;
  readonly session: MemoryPiSession;
  readonly stream: StreamFunction<TApi, PiAgentStreamOptions>;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly prompt: string;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly timestamp?: number;
  readonly streamOptions?: Omit<PiAgentStreamOptions, "sessionId">;
  readonly ownership: PiApiFirstTurnOwnership;
  readonly onPreparationTiming?: PiPreparationObserver;
  readonly onEvent?: (event: AssistantMessageEvent) => void;
  readonly providerRequestBoundary?: (
    markProviderRequestMayHaveStarted: () => void,
  ) => Promise<void>;
}

interface PiModelTurnResult {
  readonly assistantMessage: AssistantMessage;
  readonly handoffRequired: boolean;
  readonly responseStatus?: number;
}

type NewMemorySessionEntry =
  | { readonly type: "message"; readonly message: Message }
  | {
      readonly type: "model_change";
      readonly provider: string;
      readonly modelId: string;
    }
  | {
      readonly type: "thinking_level_change";
      readonly thinkingLevel: string;
    };

// Keep the memory-backed API slot aligned with the pinned Pi SDK. Pi applies
// this default when opening a new session, and when opening an older session
// that has messages but no explicit thinking_level_change entry.
const PI_DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

function serializeFileEntries(entries: readonly FileEntry[]): string {
  return `${entries
    .map((entry) => {
      return JSON.stringify(entry);
    })
    .join("\n")}\n`;
}

function generateEntryId(existingIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      return id;
    }
  }
  return randomUUID();
}

/** Byte-backed adapter around Pi's exported parser, migrations, and context projection. */
export class MemoryPiSession {
  readonly #header: SessionHeader;
  readonly #entries: SessionEntry[];
  readonly #entryIds: Set<string>;
  #leafId: string | null;

  private constructor(header: SessionHeader, entries: SessionEntry[]) {
    this.#header = header;
    this.#entries = entries;
    this.#entryIds = new Set(
      entries.map((entry) => {
        return entry.id;
      }),
    );
    this.#leafId = entries.at(-1)?.id ?? null;
  }

  static create(options: CreateMemoryPiSessionOptions): MemoryPiSession {
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: options.id,
      timestamp: options.timestamp ?? new Date().toISOString(),
      cwd: options.cwd,
      parentSession: options.parentSession,
    };
    return new MemoryPiSession(header, []);
  }

  static fromJsonl(jsonl: string): MemoryPiSession {
    const { header, entries } = parseValidatedPiSessionJsonl(jsonl);
    return new MemoryPiSession(header, entries);
  }

  appendMessage(message: Message): string {
    return this.#appendEntry({ type: "message", message });
  }

  #appendEntry(entry: NewMemorySessionEntry): string {
    const id = generateEntryId(this.#entryIds);
    const completeEntry = {
      ...entry,
      id,
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    this.#entries.push(completeEntry);
    this.#entryIds.add(id);
    this.#leafId = id;
    return id;
  }

  #activeBranch(): SessionEntry[] {
    const byId = new Map(
      this.#entries.map((entry) => {
        return [entry.id, entry] as const;
      }),
    );
    const branch: SessionEntry[] = [];
    let current = this.#leafId ? byId.get(this.#leafId) : undefined;
    while (current) {
      branch.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return branch.reverse();
  }

  /** Apply the captured run effort while retaining the prior session history. */
  prepareModelTurn<TApi extends Api>(
    model: Model<TApi>,
    thinkingLevel?: ModelThinkingLevel,
  ): void {
    const branch = this.#activeBranch();
    const hasMessages = branch.some((entry) => {
      return entry.type === "message";
    });
    if (!hasMessages) {
      this.#appendEntry({
        type: "model_change",
        provider: model.provider,
        modelId: model.id,
      });
    }
    const hasThinkingEntry = branch.some((entry) => {
      return entry.type === "thinking_level_change";
    });
    const effectiveThinkingLevel = clampThinkingLevel(
      model,
      thinkingLevel ?? PI_DEFAULT_THINKING_LEVEL,
    );
    if (
      !hasThinkingEntry ||
      (thinkingLevel !== undefined &&
        this.buildSessionContext().thinkingLevel !== effectiveThinkingLevel)
    ) {
      this.#appendEntry({
        type: "thinking_level_change",
        thinkingLevel: effectiveThinkingLevel,
      });
    }
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.#entries, this.#leafId);
  }

  /** Return the canonical active branch used by Pi's public session helpers. */
  getBranchEntries(): SessionEntry[] {
    return this.#activeBranch();
  }

  pendingToolIds(): string[] {
    const messages = this.buildSessionContext().messages;
    const resolvedIds = new Set(
      messages.flatMap((message) => {
        return message.role === "toolResult" ? [message.toolCallId] : [];
      }),
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") {
        continue;
      }
      return message.content.flatMap((content) => {
        return content.type === "toolCall" && !resolvedIds.has(content.id)
          ? [content.id]
          : [];
      });
    }
    return [];
  }

  hasPendingToolCalls(): boolean {
    return this.pendingToolIds().length > 0;
  }

  isSettledCheckpoint(): boolean {
    const lastMessage = this.buildSessionContext().messages.at(-1);
    return (
      lastMessage?.role === "assistant" &&
      lastMessage.stopReason !== "error" &&
      lastMessage.stopReason !== "aborted" &&
      !this.hasPendingToolCalls()
    );
  }

  getHeader(): SessionHeader {
    return { ...this.#header };
  }

  getSessionId(): string {
    return this.#header.id;
  }

  toJsonl(): string {
    return serializeFileEntries([this.#header, ...this.#entries]);
  }

  /** Build a user-facing derivative without changing canonical source bytes. */
  toPublicJsonl(): string {
    const entries = this.#entries.map((entry): SessionEntry => {
      if (entry.type !== "message" || entry.message.role !== "assistant") {
        return entry;
      }
      const text = entry.message.content.flatMap((item) => {
        return item.type === "text" ? [item.text] : [];
      });
      const projection = projectPiMemoryCitationSegments(text);
      let textIndex = 0;
      const errorMessage = entry.message.errorMessage;
      return {
        ...entry,
        message: {
          ...entry.message,
          ...(typeof errorMessage === "string"
            ? { errorMessage: visiblePiMemoryCitationText(errorMessage) }
            : {}),
          content: entry.message.content.map((item) => {
            if (item.type !== "text") {
              return item;
            }
            const visible = projection.visibleSegments[textIndex] ?? "";
            textIndex += 1;
            return { ...item, text: visible };
          }),
        },
      };
    });
    return serializeFileEntries([this.#header, ...entries]);
  }
}

function piReasoningLevel(
  context: SessionContext,
): PiAgentStreamOptions["reasoning"] {
  switch (context.thinkingLevel) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max": {
      return context.thinkingLevel;
    }
    default: {
      return undefined;
    }
  }
}

async function consumeAssistantMessage(
  stream: AssistantMessageEventStream,
  onEvent?: (event: AssistantMessageEvent) => void,
): Promise<AssistantMessage> {
  for await (const event of stream) {
    onEvent?.(event);
  }
  return await stream.result();
}

function piAssistantRequiresHandoff(message: AssistantMessage): boolean {
  return message.content.some((content) => {
    return content.type === "toolCall";
  });
}

export async function runPiFirstModelTurn<TApi extends Api>(
  options: RunPiFirstModelTurnOptions<TApi>,
): Promise<PiModelTurnResult> {
  const { sessionContext, context } = measurePiPreparationSync(
    options.onPreparationTiming,
    "model_context",
    () => {
      options.session.prepareModelTurn(options.model, options.thinkingLevel);
      options.session.appendMessage({
        role: "user",
        content: options.prompt,
        timestamp: options.timestamp ?? Date.now(),
      });
      const sessionContext = options.session.buildSessionContext();
      const context: Context = {
        systemPrompt: options.systemPrompt,
        messages: convertToLlm(sessionContext.messages),
        tools: [...options.tools],
      };
      return { sessionContext, context };
    },
    options.streamOptions?.signal,
  );
  if (options.providerRequestBoundary) {
    await options.providerRequestBoundary(() => {
      options.ownership.markProviderRequestMayHaveStarted();
    });
    if (options.ownership.stage !== "provider-may-have-started") {
      throw new Error(
        "Pi provider request boundary returned without claiming ownership",
      );
    }
  } else {
    options.ownership.markProviderRequestMayHaveStarted();
  }
  let responseStatus: number | undefined;
  let assistantMessage: AssistantMessage;
  const streamOptions: PiAgentStreamOptions = {
    ...options.streamOptions,
    onObservedResponseStatus(status) {
      responseStatus = status;
      options.streamOptions?.onObservedResponseStatus?.(status);
    },
    reasoning:
      options.streamOptions?.reasoning ?? piReasoningLevel(sessionContext),
    sessionId: options.session.getSessionId(),
  };
  // Preparation, durable ownership and session writes are outside this catch:
  // their failures must never authorize replay of the original H0.
  try {
    const responseStream = options.stream(
      options.model,
      context,
      streamOptions,
    );
    assistantMessage = await consumeAssistantMessage(
      responseStream,
      options.onEvent,
    );
  } catch (error) {
    throw new PiApiModelRequestError(
      error,
      options.model.provider,
      responseStatus,
    );
  }
  options.session.appendMessage(assistantMessage);
  return {
    assistantMessage,
    handoffRequired: piAssistantRequiresHandoff(assistantMessage),
    responseStatus,
  };
}

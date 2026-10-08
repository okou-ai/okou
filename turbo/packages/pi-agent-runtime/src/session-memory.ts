import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
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
interface CreateMemoryPiSessionOptions {
  readonly cwd: string;
  readonly id: string;
  readonly parentSession?: string;
  readonly timestamp?: string;
}

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

  #appendEntry(entry: {
    readonly type: "message";
    readonly message: Message;
  }): string {
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

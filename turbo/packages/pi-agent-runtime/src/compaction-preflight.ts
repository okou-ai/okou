import type {
  Api,
  AssistantMessage,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import {
  calculateContextTokens,
  getLastAssistantUsage,
  getLatestCompactionEntry,
  type SettingsManager,
  shouldCompact,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

import { PiApiFirstTurnCompactionRequiredError } from "./errors";
import type { MemoryPiSession } from "./session-memory";

/**
 * 0.86 resolves compaction settings through the manager and adds optional
 * per-model overrides, so the resolved shape is no longer `Required<CompactionSettings>`.
 */
type ResolvedCompactionSettings = ReturnType<
  SettingsManager["getCompactionSettings"]
>;

function validTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasValidUsage(usage: Usage): boolean {
  return (
    validTokenCount(usage.input) &&
    validTokenCount(usage.output) &&
    validTokenCount(usage.cacheRead) &&
    validTokenCount(usage.cacheWrite) &&
    validTokenCount(usage.totalTokens)
  );
}

function lastMessageEntry(
  session: MemoryPiSession,
): SessionMessageEntry | undefined {
  return [...session.getBranchEntries()]
    .reverse()
    .find((entry): entry is SessionMessageEntry => {
      return entry.type === "message";
    });
}

function isAssistantMessage(
  entry: SessionMessageEntry | undefined,
): entry is SessionMessageEntry & { readonly message: AssistantMessage } {
  return entry?.message.role === "assistant";
}

function requireOfficialCompaction(): never {
  throw new PiApiFirstTurnCompactionRequiredError(
    "Official Pi compaction preflight requires Sandbox ownership",
  );
}

/**
 * Prove that pinned Pi public semantics cannot compact this H0 before prompt.
 * Any private recovery or estimation path deliberately fails closed so the
 * official sandbox AgentSession.prompt() owns both the decision and execution.
 */
export function assertPiApiFirstTurnCompactionSafe<TApi extends Api>(args: {
  readonly model: Model<TApi>;
  readonly session: MemoryPiSession;
  readonly settings: ResolvedCompactionSettings;
}): void {
  if (!args.settings.enabled) {
    return;
  }

  const context = args.session.buildSessionContext();
  if (context.messages.length === 0) {
    return;
  }
  if (!args.session.isSettledCheckpoint()) {
    requireOfficialCompaction();
  }

  const branch = args.session.getBranchEntries();
  const lastEntry = lastMessageEntry(args.session);
  if (!isAssistantMessage(lastEntry)) {
    requireOfficialCompaction();
  }
  const assistant = lastEntry.message;
  if (!Number.isSafeInteger(assistant.timestamp) || assistant.timestamp < 0) {
    requireOfficialCompaction();
  }

  const latestCompaction = getLatestCompactionEntry(branch);
  if (latestCompaction) {
    const compactionTimestamp = Date.parse(latestCompaction.timestamp);
    if (!Number.isFinite(compactionTimestamp)) {
      requireOfficialCompaction();
    }
    if (assistant.timestamp <= compactionTimestamp) {
      return;
    }
  }

  // Error, abort, length recovery, and all other non-ordinary stops enter Pi
  // branches whose recovery semantics are intentionally not public.
  if (assistant.stopReason !== "stop") {
    requireOfficialCompaction();
  }

  const usage = getLastAssistantUsage([lastEntry]);
  if (!usage || !hasValidUsage(usage)) {
    requireOfficialCompaction();
  }
  const contextTokens = calculateContextTokens(usage);
  if (!Number.isSafeInteger(contextTokens) || contextTokens <= 0) {
    requireOfficialCompaction();
  }
  if (
    !Number.isSafeInteger(args.model.contextWindow) ||
    args.model.contextWindow <= 0 ||
    !validTokenCount(args.settings.reserveTokens) ||
    !validTokenCount(args.settings.keepRecentTokens)
  ) {
    requireOfficialCompaction();
  }
  if (shouldCompact(contextTokens, args.model.contextWindow, args.settings)) {
    requireOfficialCompaction();
  }
}

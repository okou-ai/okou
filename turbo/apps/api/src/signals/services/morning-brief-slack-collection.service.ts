import type {
  MorningBriefCollectionLimit,
  MorningBriefSlackBundle,
  MorningBriefSlackEntry,
} from "@okouai/api-contracts/contracts/morning-brief-collection-preview";

import {
  isSlackApiClientError,
  listSharedSlackChannelsPage,
  readSlackHistoryPage,
  readSlackRepliesPage,
} from "../../lib/slack-client";
import { settle } from "../utils";

/**
 * The first real Morning Brief source collector.
 *
 * It reads the caller's own native Slack binding — the organization's bot
 * installation intersected with that member's connected Slack account — over
 * the frozen occurrence window, and normalizes what it finds into one in-memory
 * envelope. Every read is bounded by a documented finite budget, and every way
 * the read can stop short is reported rather than rounded into a healthy empty
 * day. Nothing here is persisted or logged: message bodies, tokens and provider
 * errors stay in memory and reach only the authenticated preview caller.
 *
 * **Live scope.** Enumerating the intersection once authorizes nothing later:
 * the bot keeps its own access after the member loses theirs. Every protected
 * history or reply page is therefore preceded by a fresh bounded proof that the
 * connected member still shares that conversation, and one final proof covers
 * the window in which a response is held across a removal. Those proofs spend
 * the same finite request and time budgets as the reads, which lowers effective
 * throughput and is reported as partial; an attempt that has already spent
 * those budgets cannot buy the final proof and says so through its own limit.
 *
 * **Coverage limit.** Threads are discovered from the roots that windowed
 * history returns, so a new reply on a root older than the window is not found.
 * The declared scope is bounded channels plus those discovered threads, never a
 * complete Slack workspace or day.
 */

/**
 * Enumeration pages of the user/bot channel intersection.
 *
 * Discovery and every later authorization proof share this one page budget, so
 * revalidating the live scope introduces no new cap.
 */
const MAX_CHANNEL_PAGES = 3;
/** Channels whose history is read. */
const MAX_CHANNELS = 20;
/** History pages read per channel. */
const MAX_HISTORY_PAGES_PER_CHANNEL = 2;
/** Threads expanded across all channels, at one reply page each. */
const MAX_THREADS = 10;
/** Total Slack HTTP requests for one attempt. */
const MAX_PROVIDER_REQUESTS = 40;
/** Normalized messages kept in the bundle. */
const MAX_MESSAGES = 500;
/** Projected text carried by the bundle. */
const MAX_TEXT_BYTES = 128 * 1024;
/** Per-message projected text, so one long message cannot take the budget. */
const MAX_ENTRY_TEXT_BYTES = 4 * 1024;
/** Wall clock for the whole collection. */
export const MORNING_BRIEF_SLACK_COLLECTION_DEADLINE_MS = 30_000;

const CHANNEL_PAGE_LIMIT = 200;
const HISTORY_PAGE_LIMIT = 200;

interface MorningBriefSlackCollectionScope {
  readonly botToken: string;
  readonly slackUserId: string;
  readonly workspaceId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly timezone: string;
  readonly version: number;
}

export type MorningBriefSlackCollectionResult =
  | { readonly kind: "collected"; readonly bundle: MorningBriefSlackBundle }
  | {
      readonly kind: "rate-limited";
      readonly retryAfterSeconds: number | undefined;
    }
  | { readonly kind: "permission-denied" }
  | { readonly kind: "provider-failed" };

/**
 * Slack timestamps are `seconds.microseconds`, so they are compared and built
 * as integer microseconds. Epoch microseconds for any realistic instant stay
 * far below `Number.MAX_SAFE_INTEGER`, and never touching floating point keeps
 * the fractional boundary exact.
 */
function toMicroseconds(value: Date): number {
  return value.getTime() * 1000;
}

function parseSlackTimestamp(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match?.[1]) {
    return null;
  }
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
}

function formatSlackTimestamp(microseconds: number): string {
  const seconds = Math.floor(microseconds / 1_000_000);
  const fraction = microseconds - seconds * 1_000_000;
  return `${seconds}.${String(fraction).padStart(6, "0")}`;
}

function channelLink(workspaceId: string, channel: string): string {
  const url = new URL("https://slack.com/app_redirect");
  url.searchParams.set("team", workspaceId);
  url.searchParams.set("channel", channel);
  return url.toString();
}

interface DiscoveredChannel {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
}

interface DiscoveredThread {
  readonly channel: DiscoveredChannel;
  readonly threadTs: string;
}

/**
 * Clip text to a byte ceiling on a UTF-8 code point boundary.
 *
 * Slicing the encoded buffer at an arbitrary offset would leave a partial
 * sequence, which decodes to a replacement character three bytes wide and can
 * therefore push the projection back past the ceiling it was meant to enforce.
 * Walking back over continuation bytes keeps the result valid UTF-8, free of
 * substituted characters, and at most `maxBytes`.
 */
function clipUtf8(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  // `maxBytes` is inside the buffer on this branch and `end` only decreases, so
  // every read is in range and a broken invariant would throw rather than be
  // rounded into a byte value that stops the walk early.
  let end = maxBytes;
  while (end > 0 && (encoded.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * The finite budget one attempt spends, and the messages it has accepted.
 *
 * Every provider read passes through `spendRequest` and every accepted message
 * through `addEntry`, so no channel, thread or page loop can exceed the totals.
 * An exhausted budget is recorded as a named limit and stops collection, rather
 * than being inferred later from a short result.
 */
class SlackCollectionBudget {
  private requests = 0;
  private textBytes = 0;
  private exhausted = false;
  private readonly seen = new Set<string>();
  private readonly roots: DiscoveredThread[] = [];
  private readonly revoked = new Set<string>();
  readonly entries: MorningBriefSlackEntry[] = [];
  readonly limits = new Set<MorningBriefCollectionLimit>();

  constructor(
    private readonly scope: MorningBriefSlackCollectionScope,
    private readonly clock: () => number,
    private readonly deadline: number,
  ) {}

  /** True once a total budget stopped this attempt from reading further. */
  get stopped(): boolean {
    return this.exhausted;
  }

  private stop(limit: MorningBriefCollectionLimit): false {
    this.limits.add(limit);
    this.exhausted = true;
    return false;
  }

  note(limit: MorningBriefCollectionLimit): void {
    this.limits.add(limit);
  }

  spendRequest(): boolean {
    if (this.exhausted) {
      return false;
    }
    if (this.clock() >= this.deadline) {
      return this.stop("deadline");
    }
    if (this.requests >= MAX_PROVIDER_REQUESTS) {
      return this.stop("requests");
    }
    this.requests += 1;
    return true;
  }

  /**
   * Accept one normalized message.
   *
   * History and replies both return a thread's parent, so identity is the exact
   * `(channel, ts)` pair; the fractional timestamp is never rounded or
   * reformatted for comparison. A message longer than the per-entry ceiling is
   * carried clipped and explicitly marked, never as complete text.
   */
  addEntry(
    entry: Omit<MorningBriefSlackEntry, "text" | "textTruncated">,
    text: string,
  ): boolean {
    const key = `${entry.channelId}:${entry.ts}`;
    if (this.seen.has(key)) {
      return true;
    }
    if (this.entries.length >= MAX_MESSAGES) {
      return this.stop("messages");
    }
    const projected = clipUtf8(text, MAX_ENTRY_TEXT_BYTES);
    const size = Buffer.byteLength(projected.text, "utf8");
    if (this.textBytes + size > MAX_TEXT_BYTES) {
      return this.stop("text-bytes");
    }
    if (projected.truncated) {
      this.note("entry-text-bytes");
    }
    this.textBytes += size;
    this.seen.add(key);
    this.entries.push({
      ...entry,
      text: projected.text,
      textTruncated: projected.truncated,
    });
    return true;
  }

  /**
   * Remember one in-window thread root, up to the documented expansion budget.
   *
   * The cap lives here rather than in each channel's own list, so a channel
   * that discovers more roots than the whole attempt can expand records the
   * skipped work instead of dropping it silently.
   */
  addThread(thread: DiscoveredThread): void {
    if (this.roots.length >= MAX_THREADS) {
      this.note("threads");
      return;
    }
    this.roots.push(thread);
  }

  get threads(): readonly DiscoveredThread[] {
    return this.roots;
  }

  /**
   * Drop everything this attempt holds for a conversation it can no longer
   * prove the connected member shares.
   *
   * Authorization precedes each protected read, but a response can be held
   * across a removal that happened after its own proof. Releasing that content
   * would publish a scope the member no longer has, so it is discarded and the
   * conversation is never read again during this attempt.
   */
  revokeChannel(channelId: string): void {
    this.revoked.add(channelId);
    this.note("scope-lost");
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry?.channelId !== channelId) {
        continue;
      }
      this.textBytes -= Buffer.byteLength(entry.text, "utf8");
      this.seen.delete(`${entry.channelId}:${entry.ts}`);
      this.entries.splice(index, 1);
    }
  }

  isRevoked(channelId: string): boolean {
    return this.revoked.has(channelId);
  }

  /** Keeps a message only when it falls inside the frozen half-open window. */
  withinWindow(ts: string): boolean {
    const value = parseSlackTimestamp(ts);
    return (
      value !== null &&
      value >= toMicroseconds(this.scope.windowStart) &&
      value < toMicroseconds(this.scope.windowEnd)
    );
  }

  /**
   * Slack's `oldest` and `latest` are both exclusive by default, and the
   * request contract has no `inclusive` flag. Asking for one microsecond below
   * the window start reproduces the half-open `[start, end)` window exactly
   * instead of silently dropping a message sitting on the boundary.
   */
  get range(): { readonly oldest: string; readonly latest: string } {
    return {
      oldest: formatSlackTimestamp(toMicroseconds(this.scope.windowStart) - 1),
      latest: formatSlackTimestamp(toMicroseconds(this.scope.windowEnd)),
    };
  }

  get requestCount(): number {
    return this.requests;
  }

  get projectedTextBytes(): number {
    return this.textBytes;
  }
}

/** Slack failures are classified once, so no caller invents its own mapping. */
function classifySlackFailure(
  error: unknown,
): Exclude<MorningBriefSlackCollectionResult, { kind: "collected" }> {
  if (!isSlackApiClientError(error)) {
    return { kind: "provider-failed" };
  }
  if (error.statusCode === 429 || error.code === "ratelimited") {
    return { kind: "rate-limited", retryAfterSeconds: error.retryAfterSeconds };
  }
  if (
    error.code === "missing_scope" ||
    error.code === "no_permission" ||
    error.code === "not_in_channel" ||
    error.code === "channel_not_found"
  ) {
    return { kind: "permission-denied" };
  }
  return { kind: "provider-failed" };
}

/**
 * Enumerate the current user/bot intersection of non-archived conversations.
 *
 * The bounded page primitive asks Slack for exactly that intersection and only
 * for public and private channels, so direct messages and unshared
 * conversations never appear. A repeated cursor, or a page reporting a
 * continuation it cannot supply, ends enumeration as a recorded limit instead
 * of looping or being read as the end of the list.
 */
async function discoverChannels(
  scope: MorningBriefSlackCollectionScope,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<readonly DiscoveredChannel[]> {
  const channels: DiscoveredChannel[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
    if (!budget.spendRequest()) {
      return channels;
    }
    const result = await listSharedSlackChannelsPage(
      scope.botToken,
      scope.slackUserId,
      { limit: CHANNEL_PAGE_LIMIT, cursor },
      signal,
    );
    for (const channel of result.channels) {
      if (channel.id.startsWith("D")) {
        continue;
      }
      if (channels.length >= MAX_CHANNELS) {
        budget.note("channels");
        return channels;
      }
      channels.push({
        id: channel.id,
        name: channel.name,
        isPrivate: channel.is_private,
      });
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (cursor === undefined) {
      return channels;
    }
    if (seenCursors.has(cursor)) {
      budget.note("cursor-anomaly");
      return channels;
    }
    seenCursors.add(cursor);
  }
  budget.note("channel-pages");
  return channels;
}

/**
 * What a bounded live lookup established about the connected member's access.
 *
 * `unproven` is deliberately not an allow: a lookup that ran out of pages,
 * requests or time proves nothing, so the read it guards does not happen and
 * the attempt cannot be reported as complete.
 */
type SlackScopeProof = "shared" | "revoked" | "unproven";

/**
 * Ask Slack whether the connected member still shares one conversation.
 *
 * This is the same intersection discovery uses, charged to the same budgets and
 * carrying the same cancellation and deadline signal. It stops at the first page
 * naming the conversation, so the common case costs one request. The unbounded
 * `isSlackConversationShared` convenience loop is the behavioral precedent for
 * checking before a protected read, not a permissible implementation here.
 */
async function proveSharedScope(
  scope: MorningBriefSlackCollectionScope,
  channelId: string,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<SlackScopeProof> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
    if (!budget.spendRequest()) {
      return "unproven";
    }
    const result = await listSharedSlackChannelsPage(
      scope.botToken,
      scope.slackUserId,
      { limit: CHANNEL_PAGE_LIMIT, cursor },
      signal,
    );
    if (
      result.channels.some((channel) => {
        return channel.id === channelId;
      })
    ) {
      return "shared";
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (cursor === undefined) {
      // The member's whole intersection was listed without this conversation.
      return "revoked";
    }
    if (seenCursors.has(cursor)) {
      return "unproven";
    }
    seenCursors.add(cursor);
  }
  return "unproven";
}

/**
 * Gate one protected page read on a fresh proof of the member's own access.
 *
 * A proven removal also discards whatever this attempt already holds for the
 * conversation. An unproven lookup stops further reads without discarding
 * content that an earlier live proof did authorize, and is recorded so the
 * result can never be read as complete.
 */
async function authorizeChannelRead(
  scope: MorningBriefSlackCollectionScope,
  channelId: string,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<boolean> {
  const proof = await proveSharedScope(scope, channelId, budget, signal);
  if (proof === "shared") {
    return true;
  }
  if (proof === "revoked") {
    budget.revokeChannel(channelId);
    return false;
  }
  if (!budget.stopped) {
    // An exhausted total budget already named itself; this records the case
    // where the lookup ran and still established nothing.
    budget.note("scope-unproven");
  }
  return false;
}

/**
 * Prove the scope once more for every conversation about to leave the collector.
 *
 * Each read was authorized before it started, but its response can be held
 * across a removal. One bounded pass over the live intersection closes that gap;
 * it stops as soon as every pending conversation is named, so it normally costs
 * a single request. An attempt that has already exhausted its request or time
 * budget cannot make this call without breaking that budget, and is already
 * reported as bounded under `requests` or `deadline`.
 */
async function confirmSharedScope(
  scope: MorningBriefSlackCollectionScope,
  channelIds: readonly string[],
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<void> {
  const pending = new Set(channelIds);
  if (pending.size === 0) {
    return;
  }
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
    if (!budget.spendRequest()) {
      break;
    }
    const result = await listSharedSlackChannelsPage(
      scope.botToken,
      scope.slackUserId,
      { limit: CHANNEL_PAGE_LIMIT, cursor },
      signal,
    );
    for (const channel of result.channels) {
      pending.delete(channel.id);
    }
    if (pending.size === 0) {
      return;
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (cursor === undefined) {
      for (const channelId of pending) {
        budget.revokeChannel(channelId);
      }
      return;
    }
    if (seenCursors.has(cursor)) {
      break;
    }
    seenCursors.add(cursor);
  }
  if (!budget.stopped) {
    budget.note("scope-unproven");
  }
}

interface ChannelHistory {
  readonly read: boolean;
  readonly truncated: boolean;
}

async function readChannelHistory(
  scope: MorningBriefSlackCollectionScope,
  channel: DiscoveredChannel,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<ChannelHistory> {
  const seenCursors = new Set<string>();
  let read = false;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES_PER_CHANNEL; page += 1) {
    if (!(await authorizeChannelRead(scope, channel.id, budget, signal))) {
      return { read, truncated: true };
    }
    if (!budget.spendRequest()) {
      return { read, truncated: true };
    }
    read = true;
    const result = await readSlackHistoryPage(
      scope.botToken,
      {
        channel: channel.id,
        limit: HISTORY_PAGE_LIMIT,
        cursor,
        ...budget.range,
      },
      signal,
    );
    for (const message of result.messages) {
      if (!budget.withinWindow(message.ts)) {
        continue;
      }
      const accepted = budget.addEntry(
        {
          channelId: channel.id,
          channelName: channel.name,
          channelUrl: channelLink(scope.workspaceId, channel.id),
          ts: message.ts,
          threadTs: message.thread_ts ?? null,
          authorId: message.user ?? message.bot_id ?? null,
          fromThread: false,
        },
        message.text ?? "",
      );
      if (!accepted) {
        return { read, truncated: true };
      }
      if (message.thread_ts === message.ts && (message.reply_count ?? 0) > 0) {
        budget.addThread({ channel, threadTs: message.ts });
      }
    }
    const nextCursor = result.response_metadata?.next_cursor || undefined;
    if (nextCursor === undefined) {
      // Slack can report a continuation without handing back a usable cursor.
      // That is truncation, not the end of this channel's window.
      return { read, truncated: result.has_more === true };
    }
    if (seenCursors.has(nextCursor)) {
      budget.note("cursor-anomaly");
      return { read, truncated: true };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  budget.note("history-pages");
  return { read, truncated: true };
}

/** Exactly one reply page per expanded thread; a longer thread is truncation. */
async function readThreadReplies(
  scope: MorningBriefSlackCollectionScope,
  thread: DiscoveredThread,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<boolean> {
  if (!(await authorizeChannelRead(scope, thread.channel.id, budget, signal))) {
    return false;
  }
  if (!budget.spendRequest()) {
    return false;
  }
  const result = await readSlackRepliesPage(
    scope.botToken,
    {
      channel: thread.channel.id,
      thread: thread.threadTs,
      limit: HISTORY_PAGE_LIMIT,
      ...budget.range,
    },
    signal,
  );
  for (const message of result.messages) {
    if (!budget.withinWindow(message.ts)) {
      continue;
    }
    const accepted = budget.addEntry(
      {
        channelId: thread.channel.id,
        channelName: thread.channel.name,
        channelUrl: channelLink(scope.workspaceId, thread.channel.id),
        ts: message.ts,
        threadTs: message.thread_ts ?? thread.threadTs,
        authorId: message.user ?? message.bot_id ?? null,
        fromThread: true,
      },
      message.text ?? "",
    );
    if (!accepted) {
      return true;
    }
  }
  if (
    result.has_more === true ||
    (result.response_metadata?.next_cursor || undefined) !== undefined
  ) {
    budget.note("reply-pages");
  }
  return true;
}

/**
 * Collect one bounded Slack bundle for the frozen window.
 *
 * `signal` carries both the caller's cancellation and this attempt's deadline
 * and is handed to every provider read and authorization proof. A mid-stream
 * provider failure abandons the attempt with its classified outcome instead of
 * returning the partial data as a successful read. A conversation whose scope
 * is disproved at any point leaves nothing behind in the bundle.
 */
export async function collectMorningBriefSlackBundle(
  scope: MorningBriefSlackCollectionScope,
  options: { readonly clock: () => number; readonly deadline: number },
  signal: AbortSignal,
): Promise<MorningBriefSlackCollectionResult> {
  const budget = new SlackCollectionBudget(
    scope,
    options.clock,
    options.deadline,
  );
  const collected = await settle(
    (async () => {
      const channels = await discoverChannels(scope, budget, signal);
      const truncatedChannels = new Set<string>();
      const readChannels = new Set<string>();
      for (const channel of channels) {
        signal.throwIfAborted();
        if (budget.stopped || budget.isRevoked(channel.id)) {
          truncatedChannels.add(channel.id);
          continue;
        }
        const history = await readChannelHistory(
          scope,
          channel,
          budget,
          signal,
        );
        if (history.read) {
          readChannels.add(channel.id);
        }
        if (history.truncated) {
          truncatedChannels.add(channel.id);
        }
      }
      // Every root was discovered during the history phase above, so this list
      // is complete and no longer grows while it is expanded.
      const expandedThreads: string[] = [];
      for (const thread of budget.threads) {
        signal.throwIfAborted();
        if (budget.stopped || budget.isRevoked(thread.channel.id)) {
          truncatedChannels.add(thread.channel.id);
          continue;
        }
        if (await readThreadReplies(scope, thread, budget, signal)) {
          expandedThreads.push(thread.channel.id);
        } else {
          truncatedChannels.add(thread.channel.id);
        }
      }
      // Nothing leaves this collector before one last live proof of the scope
      // that produced it.
      await confirmSharedScope(
        scope,
        [
          ...new Set(
            budget.entries.map((entry) => {
              return entry.channelId;
            }),
          ),
        ],
        budget,
        signal,
      );
      return { channels, readChannels, expandedThreads, truncatedChannels };
    })(),
  );
  if (!collected.ok) {
    return classifySlackFailure(collected.error);
  }

  const { channels, readChannels, expandedThreads, truncatedChannels } =
    collected.value;
  const retained = channels.filter((channel) => {
    return !budget.isRevoked(channel.id);
  });
  const limits = [...budget.limits].sort();
  const coverage =
    limits.length > 0 || truncatedChannels.size > 0
      ? "partial"
      : budget.entries.length === 0
        ? "empty"
        : "complete";
  return {
    kind: "collected",
    bundle: {
      source: "slack",
      version: scope.version,
      workspaceId: scope.workspaceId,
      windowStart: scope.windowStart.toISOString(),
      windowEnd: scope.windowEnd.toISOString(),
      timezone: scope.timezone,
      coverage,
      limits,
      channels: retained.map((channel) => {
        return {
          id: channel.id,
          name: channel.name,
          url: channelLink(scope.workspaceId, channel.id),
          isPrivate: channel.isPrivate,
          truncated: truncatedChannels.has(channel.id),
        };
      }),
      entries: budget.entries,
      counts: {
        channels: retained.filter((channel) => {
          return readChannels.has(channel.id);
        }).length,
        threads: expandedThreads.filter((channelId) => {
          return !budget.isRevoked(channelId);
        }).length,
        messages: budget.entries.length,
        requests: budget.requestCount,
        textBytes: budget.projectedTextBytes,
      },
    },
  };
}

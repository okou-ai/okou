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
 * **Coverage limit.** Threads are discovered from the roots that windowed
 * history returns, so a new reply on a root older than the window is not found.
 * The declared scope is bounded channels plus those discovered threads, never a
 * complete Slack workspace or day.
 */

/** Enumeration pages of the user/bot channel intersection. */
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
   * reformatted for comparison.
   */
  addEntry(entry: MorningBriefSlackEntry, text: string): boolean {
    const key = `${entry.channelId}:${entry.ts}`;
    if (this.seen.has(key)) {
      return true;
    }
    if (this.entries.length >= MAX_MESSAGES) {
      return this.stop("messages");
    }
    const encoded = Buffer.from(text, "utf8");
    const projected =
      encoded.byteLength <= MAX_ENTRY_TEXT_BYTES
        ? text
        : encoded.subarray(0, MAX_ENTRY_TEXT_BYTES).toString("utf8");
    const size = Buffer.byteLength(projected, "utf8");
    if (this.textBytes + size > MAX_TEXT_BYTES) {
      return this.stop("text-bytes");
    }
    this.textBytes += size;
    this.seen.add(key);
    this.entries.push({ ...entry, text: projected });
    return true;
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

interface ChannelHistory {
  readonly threads: readonly DiscoveredThread[];
  readonly truncated: boolean;
}

async function readChannelHistory(
  scope: MorningBriefSlackCollectionScope,
  channel: DiscoveredChannel,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<ChannelHistory> {
  const threads: DiscoveredThread[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES_PER_CHANNEL; page += 1) {
    if (!budget.spendRequest()) {
      return { threads, truncated: true };
    }
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
          text: "",
          fromThread: false,
        },
        message.text ?? "",
      );
      if (!accepted) {
        return { threads, truncated: true };
      }
      if (
        message.thread_ts === message.ts &&
        (message.reply_count ?? 0) > 0 &&
        threads.length < MAX_THREADS
      ) {
        threads.push({ channel, threadTs: message.ts });
      }
    }
    const nextCursor = result.response_metadata?.next_cursor || undefined;
    if (nextCursor === undefined) {
      // Slack can report a continuation without handing back a usable cursor.
      // That is truncation, not the end of this channel's window.
      return { threads, truncated: result.has_more === true };
    }
    if (seenCursors.has(nextCursor)) {
      budget.note("cursor-anomaly");
      return { threads, truncated: true };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  budget.note("history-pages");
  return { threads, truncated: true };
}

/** Exactly one reply page per expanded thread; a longer thread is truncation. */
async function readThreadReplies(
  scope: MorningBriefSlackCollectionScope,
  thread: DiscoveredThread,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<void> {
  if (!budget.spendRequest()) {
    return;
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
        text: "",
        fromThread: true,
      },
      message.text ?? "",
    );
    if (!accepted) {
      return;
    }
  }
  if (
    result.has_more === true ||
    (result.response_metadata?.next_cursor || undefined) !== undefined
  ) {
    budget.note("reply-pages");
  }
}

/**
 * Collect one bounded Slack bundle for the frozen window.
 *
 * `signal` carries both the caller's cancellation and this attempt's deadline
 * and is handed to every provider read. A mid-stream provider failure abandons
 * the attempt with its classified outcome instead of returning the partial data
 * as a successful read.
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
      const threads: DiscoveredThread[] = [];
      const truncatedChannels = new Set<string>();
      let readChannels = 0;
      for (const channel of channels) {
        signal.throwIfAborted();
        if (budget.stopped) {
          truncatedChannels.add(channel.id);
          continue;
        }
        const history = await readChannelHistory(
          scope,
          channel,
          budget,
          signal,
        );
        readChannels += 1;
        if (history.truncated) {
          truncatedChannels.add(channel.id);
        }
        for (const thread of history.threads) {
          if (threads.length < MAX_THREADS) {
            threads.push(thread);
          } else {
            budget.note("threads");
          }
        }
      }
      let expandedThreads = 0;
      for (const thread of threads) {
        signal.throwIfAborted();
        if (budget.stopped) {
          truncatedChannels.add(thread.channel.id);
          continue;
        }
        await readThreadReplies(scope, thread, budget, signal);
        expandedThreads += 1;
      }
      return { channels, readChannels, expandedThreads, truncatedChannels };
    })(),
  );
  if (!collected.ok) {
    return classifySlackFailure(collected.error);
  }

  const { channels, readChannels, expandedThreads, truncatedChannels } =
    collected.value;
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
      channels: channels.map((channel) => {
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
        channels: readChannels,
        threads: expandedThreads,
        messages: budget.entries.length,
        requests: budget.requestCount,
        textBytes: budget.projectedTextBytes,
      },
    },
  };
}

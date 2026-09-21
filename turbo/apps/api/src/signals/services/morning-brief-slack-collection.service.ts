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
 * **Live scope.** Discovery authorizes nothing later: the bot keeps its own
 * access after the member loses theirs. No protected history or reply page is
 * therefore read without a bounded proof that the connected member still
 * shares that conversation — one pass taken after discovery, which answers
 * every conversation this attempt reads — and one final proof is the release
 * boundary for everything the bundle would name. Those proofs spend the same
 * finite request and time budgets as the reads, which lowers effective
 * throughput and is reported as partial.
 *
 * **Containment.** One conversation that cannot be read is not the source. A
 * conversation outside the readable surface — one the bot was never invited to,
 * one that no longer exists, one that has been archived — leaves the bundle
 * silently, because a workspace's access decision is not a gap in this owner's
 * morning. A conversation inside the surface that did not answer is named as a
 * limit, so coverage cannot claim a morning this attempt did not see. Either
 * way the conversations already read and proved are still released. Only a loss
 * of the authority the whole read runs under — the installation's identity, its
 * credential, its granted scope — fails the source as a whole.
 *
 * **Release authority.** Coverage and authorization are separate facts. A
 * bounded attempt may omit work and say so, but it may never release a
 * conversation's content, name, id or link without a fresh proof that the
 * connected member still shares it. What the final pass could not prove is
 * withheld — unproven is not proven revoked, and it is not a healthy empty
 * channel either. The wall clock bounds that authority as a whole rather than
 * one conversation at a time: an attempt that expires releases nothing, even
 * what an earlier page of the same final pass had already confirmed.
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
/**
 * Requests held back from the reads so the final release proof can run.
 *
 * The proof spends the same total budget as the reads it authorizes, so a read
 * phase allowed to spend every request would leave nothing to prove the scope
 * of what it collected — and content without a current proof cannot be
 * released. Holding one enumeration's worth of pages back keeps the documented
 * 40-request ceiling exactly where it is and lowers the read allowance instead.
 */
const MAX_READ_REQUESTS = MAX_PROVIDER_REQUESTS - MAX_CHANNEL_PAGES;
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
      /** Exact provider requests this failed attempt issued. */
      readonly requests: number;
    }
  | { readonly kind: "permission-denied"; readonly requests: number }
  | { readonly kind: "provider-failed"; readonly requests: number };

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
  private readonly excluded = new Set<string>();
  private readonly withheld = new Set<string>();
  readonly entries: MorningBriefSlackEntry[] = [];
  readonly limits = new Set<MorningBriefCollectionLimit>();

  constructor(
    private readonly scope: MorningBriefSlackCollectionScope,
    private readonly clock: () => number,
    private readonly deadline: number,
    /**
     * When this attempt stops reading, ahead of the deadline that cancels it.
     *
     * Reading up to `deadline` spends the same instant the caller's signal
     * fires on, so the attempt is aborted mid-read instead of stopping: the
     * abort escapes classification, the source is rejected outright, and every
     * message these reads already collected and proved is discarded. Leaving
     * the last stretch to the release proof is what lets an attempt that ran
     * out of time still hand back the conversations it actually read.
     *
     * Required rather than defaulted. A default is how one of this
     * collector's two callers would keep the destructive behaviour by saying
     * nothing, and there is no caller that legitimately wants to read until
     * the instant it is cancelled.
     */
    private readonly readDeadline: number,
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

  /**
   * Stop reading for this attempt while its release proof still runs.
   *
   * The provider refusing one read refuses the next one just as well, so the
   * read phase ends here rather than spending the rest of its allowance on
   * answers it has already been told it cannot have. The reserved proof
   * allowance is untouched, which is what lets the conversations this attempt
   * did read be proved and released instead of discarded.
   */
  stopReading(limit: MorningBriefCollectionLimit): void {
    this.stop(limit);
  }

  private spendWithin(ceiling: number, until: number): boolean {
    if (this.clock() >= until) {
      return this.stop("deadline");
    }
    if (this.requests >= ceiling) {
      return this.stop("requests");
    }
    this.requests += 1;
    return true;
  }

  /** Spend one request on discovery, a pre-read proof or a protected read. */
  spendRequest(): boolean {
    if (this.exhausted) {
      return false;
    }
    return this.spendWithin(MAX_READ_REQUESTS, this.readDeadline);
  }

  /**
   * Spend one request on the final release proof, from the reserved allowance.
   *
   * A content cap stopped this attempt from reading further, but it never
   * waives authorization, so the reserve stays available to the proof even
   * then. Only the total request ceiling and the wall clock can refuse it.
   */
  spendProofRequest(): boolean {
    return this.spendWithin(MAX_PROVIDER_REQUESTS, this.deadline);
  }

  /**
   * Stop this attempt when its wall clock has already passed.
   *
   * A proof's own answer can be held across the deadline, so the boundary is
   * checked again when that answer lands rather than only before it is sent.
   */
  stopIfExpired(): boolean {
    if (this.clock() < this.deadline) {
      return false;
    }
    this.stop("deadline");
    return true;
  }

  /**
   * Withhold everything still held once this attempt's wall clock has passed.
   *
   * The deadline bounds the whole attempt, not one conversation's proof. A
   * channel named by an earlier page of the final enumeration is already
   * settled and no longer pending, so an expiry that stops a later page of the
   * same pass would otherwise leave that earlier channel releasable — and its
   * messages, name, id and link would be published under a proof the attempt
   * has outlived. The release decision therefore re-reads the clock after every
   * awaited answer, and an expired attempt keeps each conversation it can still
   * speak about inside the collector instead. A conversation already proven
   * revoked stays a proven removal rather than being renamed unproven.
   */
  withholdIfExpired(channelIds: readonly string[]): void {
    if (!this.stopIfExpired()) {
      return;
    }
    for (const channelId of channelIds) {
      if (this.isReleasable(channelId)) {
        this.withholdChannel(channelId);
      }
    }
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

  private discardChannel(channelId: string): void {
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
    this.discardChannel(channelId);
  }

  /**
   * Drop a conversation that is not part of this owner's readable surface.
   *
   * A channel the bot was never invited to, one that no longer exists, and one
   * that has been archived are all outside what this attempt could ever have
   * covered. That boundary is the workspace's own decision, not a gap in the
   * morning: reporting it as an omission would describe a member's access
   * choice as a degraded read and push a fully covered morning to `partial`.
   * So no limit is recorded and coverage is left alone — the conversation
   * simply leaves the bundle, with whatever this attempt held for it. Content
   * read before the removal is discarded for the same reason a proven
   * revocation discards it: it may not be released out of a conversation the
   * reader is no longer in.
   */
  excludeChannel(channelId: string): void {
    this.excluded.add(channelId);
    this.discardChannel(channelId);
  }

  /**
   * Withhold a conversation whose final scope proof could not be completed.
   *
   * Unproven is neither an allow nor a proven removal, so the attempt simply
   * may not speak about this conversation: its messages, name, id and link all
   * stay inside the collector. Nothing falls back to discovery or to the
   * earlier pre-read proof, which covered only the instant it ran.
   */
  withholdChannel(channelId: string): void {
    this.withheld.add(channelId);
    this.note("scope-unproven");
    this.discardChannel(channelId);
  }

  /** True once this attempt stopped reading a conversation for good. */
  isDropped(channelId: string): boolean {
    return this.revoked.has(channelId) || this.excluded.has(channelId);
  }

  /** True when a fresh proof still authorizes naming this conversation. */
  isReleasable(channelId: string): boolean {
    return !this.isDropped(channelId) && !this.withheld.has(channelId);
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

/**
 * Provider errors that take one conversation out of this attempt's surface.
 *
 * `not_in_channel` and `channel_not_found` are the reader's own access
 * boundary: the conversation is not part of what this owner's brief could have
 * covered. An archived conversation has no live morning to miss either.
 */
const OUT_OF_SCOPE_CONVERSATION_CODES: readonly string[] = [
  "channel_not_found",
  "is_archived",
  "not_in_channel",
];

/**
 * Provider errors that end the whole attempt rather than one conversation.
 *
 * These name the authority every read runs under — the installation's identity,
 * its credential and its granted scope — so the next conversation would fail
 * exactly the same way and the source has to report the failure instead of
 * quietly covering less of the morning.
 */
const SOURCE_FATAL_SLACK_CODES: readonly string[] = [
  "account_inactive",
  "ekm_access_denied",
  "invalid_auth",
  "missing_scope",
  "no_permission",
  "not_authed",
  "org_login_required",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
];

/**
 * What one conversation's failed provider read means for this attempt.
 *
 * `out-of-scope` is a conversation that was never part of the readable surface,
 * `unread` is one this owner is entitled to read that did not answer, and
 * `rate-limited` is the provider refusing the reads themselves. Only
 * `source-fatal` is about the whole attempt.
 */
type SlackConversationFailure =
  | "out-of-scope"
  | "unread"
  | "rate-limited"
  | "source-fatal";

function classifyConversationFailure(error: unknown): SlackConversationFailure {
  if (!isSlackApiClientError(error)) {
    // A transport or decoding failure belongs to this one request. The
    // attempt's cancellation and its deadline never reach here: `settle`
    // re-throws an abort ahead of any classification.
    return "unread";
  }
  if (error.statusCode === 429 || error.code === "ratelimited") {
    return "rate-limited";
  }
  if (SOURCE_FATAL_SLACK_CODES.includes(error.code)) {
    return "source-fatal";
  }
  return OUT_OF_SCOPE_CONVERSATION_CODES.includes(error.code)
    ? "out-of-scope"
    : "unread";
}

/**
 * Keep one conversation's failed read inside that conversation.
 *
 * A single `ok:false` used to escape the read loop and discard the whole
 * source, so one conversation the bot had never been invited to threw away the
 * thirteen conversations already read and proved (#35818). The failure is
 * contained here instead, and the two kinds of containment are deliberately
 * different: a conversation outside the readable surface leaves silently,
 * while unread work inside it is named so coverage cannot claim a morning this
 * attempt did not see. Losing the authority the whole read runs under is
 * neither, and is re-thrown for the source to classify.
 */
function containConversationFailure(
  channelId: string,
  error: unknown,
  budget: SlackCollectionBudget,
): SlackConversationFailure {
  const failure = classifyConversationFailure(error);
  if (failure === "source-fatal") {
    throw error;
  }
  if (failure === "out-of-scope") {
    budget.excludeChannel(channelId);
    return failure;
  }
  if (failure === "rate-limited") {
    budget.stopReading("rate-limited");
    return failure;
  }
  budget.note("conversation-failed");
  return failure;
}

/**
 * Slack failures are classified once, so no caller invents its own mapping.
 *
 * This is the source-level classifier for a failure that bounds the whole
 * attempt — enumeration, the release proof, or an authority loss a read
 * re-threw. A per-conversation error no longer arrives here; the codes that
 * describe one conversation stay mapped for any other origin.
 */
function classifySlackFailure(
  error: unknown,
  requests: number,
): Exclude<MorningBriefSlackCollectionResult, { kind: "collected" }> {
  if (!isSlackApiClientError(error)) {
    return { kind: "provider-failed", requests };
  }
  if (error.statusCode === 429 || error.code === "ratelimited") {
    return {
      kind: "rate-limited",
      retryAfterSeconds: error.retryAfterSeconds,
      requests,
    };
  }
  if (
    error.code === "missing_scope" ||
    error.code === "no_permission" ||
    error.code === "not_in_channel" ||
    error.code === "channel_not_found"
  ) {
    return { kind: "permission-denied", requests };
  }
  return { kind: "provider-failed", requests };
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
      if (channel.is_member === false) {
        // The bot cannot read a public conversation it never joined, so
        // enumerating one only buys a `not_in_channel` a request later. Every
        // conversation this enumeration lists is one the connected member
        // belongs to, which is why an explicit `false` can only be about the
        // calling bot: reading it as the member's own membership would make it
        // a value Slack could never return here. An absent field filters
        // nothing and leaves the read path's own containment to answer.
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
 * One bounded walk of the member's live intersection, over a pending set.
 *
 * This is the same intersection discovery uses, carrying the same cancellation
 * and deadline signal, and charged to whichever allowance the caller is
 * spending from. Every conversation the walk names is deleted from `pending`,
 * so what remains afterwards is what it never saw, and the walk stops at the
 * first page that settles them all — one request in the ordinary case, however
 * many conversations were asked about.
 *
 * The return value says whether that silence is an answer. A walk that named
 * everything, or that listed the member's whole intersection, is complete, and
 * whatever is still pending is provably outside that intersection. A walk
 * stopped by its page cap, its allowance, a repeated cursor or the attempt's
 * wall clock proves nothing about what is still pending: unproven is never an
 * allow. The unbounded `isSlackConversationShared` convenience loop is the
 * behavioral precedent for checking before a protected read, not a permissible
 * implementation here.
 */
async function walkSharedScope(
  scope: MorningBriefSlackCollectionScope,
  pending: Set<string>,
  allowance: {
    /** Spend one enumeration request, from the caller's own allowance. */
    readonly spend: () => boolean;
    /** True once the attempt's wall clock has outlived a held answer. */
    readonly expired: () => boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
    if (!allowance.spend()) {
      return false;
    }
    const result = await listSharedSlackChannelsPage(
      scope.botToken,
      scope.slackUserId,
      { limit: CHANNEL_PAGE_LIMIT, cursor },
      signal,
    );
    // An answer that lands after this attempt's own wall clock is no longer a
    // current proof, however well the request was started inside it.
    if (allowance.expired()) {
      return false;
    }
    for (const channel of result.channels) {
      pending.delete(channel.id);
    }
    if (pending.size === 0) {
      return true;
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (cursor === undefined) {
      // The member's whole intersection was listed without them.
      return true;
    }
    if (seenCursors.has(cursor)) {
      return false;
    }
    seenCursors.add(cursor);
  }
  return false;
}

/**
 * The pre-read authorization this attempt takes once, for every conversation.
 *
 * Enumerating per conversation asked one identical question fifteen times in
 * production, spent twenty-nine of the thirty-seven read requests on the same
 * 14 KB page, and at nineteen conversations would have exhausted the read
 * allowance before a single message was collected (#35818). One walk answers
 * every conversation's question, because the intersection it lists is the
 * whole answer rather than one conversation's row of it.
 *
 * Freshness still bounds how much this one pass may authorize: it is taken
 * after discovery and before the first protected read, and the final release
 * proof — a separate enumeration that every conversation in the bundle must
 * pass — remains the boundary a removal during the read phase is caught by.
 */
class SharedScopeProof {
  private readonly asked: ReadonlySet<string>;
  private pass:
    | Promise<{
        readonly unnamed: ReadonlySet<string>;
        readonly complete: boolean;
      }>
    | undefined;

  constructor(
    private readonly scope: MorningBriefSlackCollectionScope,
    private readonly budget: SlackCollectionBudget,
    channels: readonly DiscoveredChannel[],
  ) {
    this.asked = new Set(
      channels.map((channel) => {
        return channel.id;
      }),
    );
  }

  /**
   * What this attempt can prove about the member's access to one conversation.
   *
   * The first question takes the pass and every later one reads its answer, so
   * an attempt enumerates at most once here. A conversation the pass was never
   * asked about is unproven rather than allowed.
   */
  async prove(
    channelId: string,
    signal: AbortSignal,
  ): Promise<SlackScopeProof> {
    if (!this.asked.has(channelId)) {
      return "unproven";
    }
    this.pass ??= this.take(signal);
    const { unnamed, complete } = await this.pass;
    if (!unnamed.has(channelId)) {
      return "shared";
    }
    return complete ? "revoked" : "unproven";
  }

  private async take(signal: AbortSignal): Promise<{
    readonly unnamed: ReadonlySet<string>;
    readonly complete: boolean;
  }> {
    const pending = new Set(this.asked);
    const complete = await walkSharedScope(
      this.scope,
      pending,
      {
        spend: () => {
          return this.budget.spendRequest();
        },
        expired: () => {
          return this.budget.stopIfExpired();
        },
      },
      signal,
    );
    return { unnamed: pending, complete };
  }
}

/**
 * Gate one protected page read on this attempt's proof of the member's access.
 *
 * A proven removal also discards whatever this attempt already holds for the
 * conversation. An unproven lookup stops further reads and is recorded so the
 * result can never be read as complete; whether the pages it already read may
 * be released is not decided here but at the final proof, which every
 * conversation in the bundle must pass.
 */
async function authorizeChannelRead(
  proof: SharedScopeProof,
  channelId: string,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<boolean> {
  const proven = await proof.prove(channelId, signal);
  if (proven === "shared") {
    return true;
  }
  if (proven === "revoked") {
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
 * This is the release boundary. Each read was authorized before it started, but
 * its response can be held across a removal, and a conversation can reach the
 * bundle as a name, id and link without any protected read at all — so every
 * conversation the bundle would carry is pending here, not only the ones that
 * produced messages. One bounded pass over the live intersection stops as soon
 * as each pending conversation is named, so it normally costs a single request,
 * and it spends the allowance reserved for exactly this call.
 *
 * A pass that lists the member's whole intersection without a conversation
 * proves its removal. A pass that repeats a cursor, exhausts its pages or its
 * reserved requests proves nothing about what is still pending, and what it
 * could not prove is withheld rather than released. Partial coverage is an
 * omission of work; it is never permission to publish unconfirmed scope.
 *
 * The wall clock is not one of those page budgets. It bounds the attempt rather
 * than this pass's remaining work, so an expiry is settled by the caller's
 * release decision over every conversation, not only by the set still pending
 * here.
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
  const complete = await walkSharedScope(
    scope,
    pending,
    {
      spend: () => {
        return budget.spendProofRequest();
      },
      expired: () => {
        return budget.stopIfExpired();
      },
    },
    signal,
  );
  for (const channelId of pending) {
    if (complete) {
      // The pass listed the member's whole intersection without it.
      budget.revokeChannel(channelId);
    } else {
      budget.withholdChannel(channelId);
    }
  }
}

interface ChannelHistory {
  readonly read: boolean;
  readonly truncated: boolean;
}

async function readChannelHistory(
  scope: MorningBriefSlackCollectionScope,
  proof: SharedScopeProof,
  channel: DiscoveredChannel,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<ChannelHistory> {
  const seenCursors = new Set<string>();
  let read = false;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES_PER_CHANNEL; page += 1) {
    if (!(await authorizeChannelRead(proof, channel.id, budget, signal))) {
      return { read, truncated: true };
    }
    if (!budget.spendRequest()) {
      return { read, truncated: true };
    }
    const answer = await settle(
      readSlackHistoryPage(
        scope.botToken,
        {
          channel: channel.id,
          limit: HISTORY_PAGE_LIMIT,
          cursor,
          ...budget.range,
        },
        signal,
      ),
      signal,
    );
    if (!answer.ok) {
      const failure = containConversationFailure(
        channel.id,
        answer.error,
        budget,
      );
      // A conversation outside the readable surface is not a truncated one:
      // it leaves the bundle, with nothing for coverage to be short of.
      return { read, truncated: failure !== "out-of-scope" };
    }
    // A page that answered is what makes this conversation one the attempt
    // read; a request that failed leaves it unread however it is reported.
    read = true;
    const result = answer.value;
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

/**
 * Exactly one reply page per expanded thread; a longer thread is truncation.
 *
 * A thread that fails to answer costs this conversation its expansion and
 * nothing else. The channel history that discovered the root was already
 * collected and proved, and a reply page is the last work of the read phase, so
 * there is nothing a failure here could honestly invalidate.
 */
async function readThreadReplies(
  scope: MorningBriefSlackCollectionScope,
  proof: SharedScopeProof,
  thread: DiscoveredThread,
  budget: SlackCollectionBudget,
  signal: AbortSignal,
): Promise<boolean> {
  if (!(await authorizeChannelRead(proof, thread.channel.id, budget, signal))) {
    return false;
  }
  if (!budget.spendRequest()) {
    return false;
  }
  const answer = await settle(
    readSlackRepliesPage(
      scope.botToken,
      {
        channel: thread.channel.id,
        thread: thread.threadTs,
        limit: HISTORY_PAGE_LIMIT,
        ...budget.range,
      },
      signal,
    ),
    signal,
  );
  if (!answer.ok) {
    containConversationFailure(thread.channel.id, answer.error, budget);
    return false;
  }
  const result = answer.value;
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
 * and is handed to every provider read and authorization proof. A provider
 * failure on one conversation is contained to that conversation; a failure of
 * the enumeration, of the release proof, or of the authority every read runs
 * under abandons the attempt with its classified outcome instead of returning
 * partial data as a successful read. A conversation whose scope is disproved,
 * or which the final proof could not confirm, leaves nothing behind in the
 * bundle — no message, name, id or link.
 */
export async function collectMorningBriefSlackBundle(
  scope: MorningBriefSlackCollectionScope,
  options: {
    readonly clock: () => number;
    readonly deadline: number;
    /** When reading stops, leaving the rest of the budget to the proof. */
    readonly readDeadline: number;
  },
  signal: AbortSignal,
): Promise<MorningBriefSlackCollectionResult> {
  const budget = new SlackCollectionBudget(
    scope,
    options.clock,
    options.deadline,
    options.readDeadline,
  );
  const collected = await settle(
    (async () => {
      const channels = await discoverChannels(scope, budget, signal);
      const proof = new SharedScopeProof(scope, budget, channels);
      const truncatedChannels = new Set<string>();
      const readChannels = new Set<string>();
      for (const channel of channels) {
        signal.throwIfAborted();
        // A dropped conversation is not part of this attempt's surface, so it
        // is neither read again nor reported as work the morning is short of.
        if (budget.isDropped(channel.id)) {
          continue;
        }
        if (budget.stopped) {
          truncatedChannels.add(channel.id);
          continue;
        }
        const history = await readChannelHistory(
          scope,
          proof,
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
        if (budget.isDropped(thread.channel.id)) {
          continue;
        }
        if (budget.stopped) {
          truncatedChannels.add(thread.channel.id);
          continue;
        }
        if (await readThreadReplies(scope, proof, thread, budget, signal)) {
          expandedThreads.push(thread.channel.id);
        } else if (!budget.isDropped(thread.channel.id)) {
          truncatedChannels.add(thread.channel.id);
        }
      }
      // Nothing leaves this collector — message, name, id or link — before one
      // last live proof of the scope that produced it.
      const pendingRelease = channels
        .filter((channel) => {
          return !budget.isDropped(channel.id);
        })
        .map((channel) => {
          return channel.id;
        });
      await confirmSharedScope(scope, pendingRelease, budget, signal);
      // The proof is the last awaited work before the projection below, so this
      // is where the attempt's own wall clock decides whether any of it may
      // still be released at all.
      budget.withholdIfExpired(pendingRelease);
      return { channels, readChannels, expandedThreads, truncatedChannels };
    })(),
  );
  if (!collected.ok) {
    return classifySlackFailure(collected.error, budget.requestCount);
  }

  const { channels, readChannels, expandedThreads, truncatedChannels } =
    collected.value;
  // Only what the final proof confirmed is describable at all, so the counts
  // below report the returned payload rather than the withheld identities.
  const released = channels.filter((channel) => {
    return budget.isReleasable(channel.id);
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
      channels: released.map((channel) => {
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
        channels: released.filter((channel) => {
          return readChannels.has(channel.id);
        }).length,
        threads: expandedThreads.filter((channelId) => {
          return budget.isReleasable(channelId);
        }).length,
        messages: budget.entries.length,
        requests: budget.requestCount,
        textBytes: budget.projectedTextBytes,
      },
    },
  };
}

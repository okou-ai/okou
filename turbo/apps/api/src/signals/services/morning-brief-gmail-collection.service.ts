import type {
  MorningBriefBranchOutcome,
  MorningBriefGmailBranch,
  MorningBriefGmailCollection,
  MorningBriefGmailItem,
  MorningBriefTruncation,
} from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";
import { Buffer } from "node:buffer";
import { convert } from "html-to-text";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import type { ClerkClient } from "../external/clerk";
import type { Db } from "../external/db";
import {
  withMorningBriefConnectorReader,
  type MorningBriefCollectionScope,
  type MorningBriefConnectorReader,
  type MorningBriefReadOutcome,
} from "./morning-brief-connector-reader.service";

/**
 * Bounded Gmail collection for Simple Morning Brief.
 *
 * Two branches are collected and merged: the messages that arrived inside the
 * occurrence's exact `[anchor - 24h, anchor)` window, and the mailbox's current
 * unread backlog, which has no invented lower bound and is a read-time
 * snapshot rather than unread state as of the anchor.
 *
 * This module owns paths, windows and normalization only. Authority, the
 * credential, the host and every cap live in the shared reader.
 */

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
const GMAIL_CONNECTOR_SLUG = "gmail" as const;
const GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME = "GMAIL_TOKEN";

const GMAIL_COLLECTION_CAPS = Object.freeze({
  recentWindowMs: 24 * 60 * 60 * 1000,
  listPagesPerBranch: 2,
  candidatesPerPage: 25,
  maxDetailRequests: 40,
  maxRequests: 44,
  concurrency: 3,
  deadlineMs: 20_000,
  maxResponseBytes: 256 * 1024,
  maxTotalResponseBytes: 4 * 1024 * 1024,
  maxExcerptCharacters: 2000,
  maxTextCharacters: 40_000,
  maxMimeDepth: 12,
  maxMimeNodes: 200,
  maxDecodedBodyBytes: 512 * 1024,
});

/**
 * Per-header ceilings, each sized for what its field legitimately carries.
 *
 * A provider header is transport-valid long before it is reasonable, so every
 * retained value is projected to its own small ceiling and then charged to the
 * shared text budget below. None of these widen a transport, request or
 * aggregate cap: they only decide how much of an arrived response is kept.
 */
const GMAIL_HEADER_CHARACTER_CAPS = Object.freeze({
  /** A wrapped RFC 5322 subject line, far short of a message body. */
  subject: 300,
  /** One RFC 5321 mailbox is 64 + `@` + 255 characters, plus a display name. */
  from: 320,
  /** `To` legitimately lists several mailboxes. */
  to: 1000,
  /** An RFC 5322 date-time with its zone and a short comment. */
  date: 64,
});

const BRANCHES: readonly MorningBriefGmailBranch[] = ["recent", "unread"];

const gmailListResponseSchema = z.object({
  messages: z
    .array(z.object({ id: z.string(), threadId: z.string() }))
    .optional(),
  nextPageToken: z.string().optional(),
});

interface GmailMessagePart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly body?: { readonly size?: number; readonly data?: string };
  readonly parts?: readonly GmailMessagePart[];
}

const gmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() => {
  return z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
    body: z
      .object({ size: z.number().optional(), data: z.string().optional() })
      .optional(),
    parts: z.array(gmailMessagePartSchema).optional(),
  });
});

/** The largest instant a `Date` can represent, in milliseconds. */
const MAX_EPOCH_MILLISECONDS = 8.64e15;

function decodeEpochMilliseconds(value: string): number | null {
  if (!/^-?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    Math.abs(parsed) <= MAX_EPOCH_MILLISECONDS
    ? parsed
    : null;
}

/**
 * Gmail sends `internalDate` as decimal epoch milliseconds.
 *
 * A value this collector cannot turn into a real instant is provider data, and
 * rejecting it at the decode boundary is what lets the shared reader report it
 * as `malformed`. Accepting any string instead silently dropped a message whose
 * timestamp fell outside the window and threw out of `toISOString` during
 * normalization — after the reader had already returned, where its unavailable
 * mapping can no longer catch anything. No timestamp is ever invented.
 */
const gmailInternalDateSchema = z.string().transform((value, ctx) => {
  const parsed = decodeEpochMilliseconds(value);
  if (parsed === null) {
    ctx.addIssue({
      code: "custom",
      message: "Expected internalDate to be epoch milliseconds",
    });
    return z.NEVER;
  }
  return parsed;
});

const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  internalDate: gmailInternalDateSchema,
  labelIds: z.array(z.string()).optional(),
  payload: gmailMessagePartSchema.optional(),
});

type GmailMessage = z.infer<typeof gmailMessageSchema>;

interface BranchCandidate {
  readonly id: string;
  readonly threadId: string;
}

interface BranchResult {
  readonly candidates: readonly BranchCandidate[];
  outcome: MorningBriefBranchOutcome;
}

interface CollectionState {
  readonly truncations: Set<MorningBriefTruncation>;
  detailRequests: number;
  retryAfterMs: number | null;
  /** A provider rate limit occurred, whether or not it advised a delay. */
  rateLimited: boolean;
  failed: boolean;
  /**
   * Message bodies are shared by both branches, so a refusal or cap there
   * degrades the coverage of every branch that selected the message.
   */
  detailOutcome: MorningBriefBranchOutcome | null;
}

function headerValue(message: GmailMessage, name: string): string | null {
  const header = message.payload?.headers?.find((entry) => {
    return entry.name.toLowerCase() === name;
  });
  return header?.value ?? null;
}

function decodeBase64Url(data: string, maxBytes: number): string | null {
  const buffer = Buffer.from(data, "base64url");
  if (buffer.byteLength > maxBytes) {
    return null;
  }
  return buffer.toString("utf8");
}

interface BodyWalkResult {
  text: string | null;
  html: string | null;
  /** A depth or node cap stopped the walk before the structure was exhausted. */
  truncatedNodes: boolean;
}

/**
 * A part with a filename is an attachment.
 *
 * The whole subtree is pruned, not only the part itself: a `message/rfc822`
 * attachment carries a complete message underneath it, and continuing into its
 * children let attached content supply this message's inline text. Attachments
 * are never fetched and never opened.
 */
function isAttachment(part: GmailMessagePart): boolean {
  return (part.filename ?? "").length > 0;
}

/** Capture one inline part's text, preferring the first of each type. */
function captureInlineText(
  part: GmailMessagePart,
  result: BodyWalkResult,
): void {
  const data = part.body?.data;
  if (data === undefined) {
    return;
  }
  const mimeType = part.mimeType ?? "";
  if (mimeType.startsWith("text/plain") && result.text === null) {
    result.text = decodeBase64Url(
      data,
      GMAIL_COLLECTION_CAPS.maxDecodedBodyBytes,
    );
    return;
  }
  if (mimeType.startsWith("text/html") && result.html === null) {
    result.html = decodeBase64Url(
      data,
      GMAIL_COLLECTION_CAPS.maxDecodedBodyBytes,
    );
  }
}

/** Walk the MIME tree for inline text, bounded by depth and node count. */
function walkMessageBody(
  payload: GmailMessagePart | undefined,
): BodyWalkResult {
  const result: BodyWalkResult = {
    text: null,
    html: null,
    truncatedNodes: false,
  };
  if (!payload) {
    return result;
  }
  const queue: { readonly part: GmailMessagePart; readonly depth: number }[] = [
    { part: payload, depth: 0 },
  ];
  let visited = 0;
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    visited += 1;
    if (visited > GMAIL_COLLECTION_CAPS.maxMimeNodes) {
      result.truncatedNodes = true;
      break;
    }
    const { part, depth } = next;
    if (isAttachment(part)) {
      continue;
    }
    captureInlineText(part, result);
    if (result.text !== null) {
      break;
    }
    if (depth >= GMAIL_COLLECTION_CAPS.maxMimeDepth) {
      result.truncatedNodes ||= (part.parts?.length ?? 0) > 0;
      continue;
    }
    for (const child of part.parts ?? []) {
      queue.push({ part: child, depth: depth + 1 });
    }
  }
  return result;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface Excerpt {
  readonly excerpt: string;
  readonly source: MorningBriefGmailItem["excerptSource"];
  readonly truncated: boolean;
  /** A MIME cap cut the walk short, so the structure was not fully seen. */
  readonly mimeTruncated: boolean;
}

/**
 * Prefer decoded inline `text/plain`. An HTML-only message goes through the
 * repository's existing bounded normalizer; when that yields nothing usable the
 * item declares limited coverage instead of inventing content.
 *
 * A MIME cap is its own state. Reporting it as `html-only` claimed the message
 * really carried no inline text, when a plaintext part may simply never have
 * been reached.
 */
function messageExcerpt(message: GmailMessage): Excerpt {
  const body = walkMessageBody(message.payload);
  if (body.text !== null) {
    return boundExcerpt(
      collapseWhitespace(body.text),
      "text-plain",
      body.truncatedNodes,
    );
  }
  if (body.html !== null) {
    const normalized = collapseWhitespace(
      convert(body.html, {
        wordwrap: false,
        limits: { maxInputLength: GMAIL_COLLECTION_CAPS.maxDecodedBodyBytes },
      }),
    );
    if (normalized.length > 0) {
      return boundExcerpt(normalized, "html-normalized", body.truncatedNodes);
    }
  }
  if (body.truncatedNodes) {
    return {
      excerpt: "",
      source: "mime-truncated",
      truncated: false,
      mimeTruncated: true,
    };
  }
  return {
    excerpt: "",
    source: body.html === null ? "none" : "html-only",
    truncated: false,
    mimeTruncated: false,
  };
}

function boundExcerpt(
  value: string,
  source: MorningBriefGmailItem["excerptSource"],
  mimeTruncated: boolean,
): Excerpt {
  const truncated = value.length > GMAIL_COLLECTION_CAPS.maxExcerptCharacters;
  return {
    excerpt: truncated
      ? value.slice(0, GMAIL_COLLECTION_CAPS.maxExcerptCharacters)
      : value,
    source,
    truncated,
    mimeTruncated,
  };
}

/**
 * A safe deep link for the pinned account.
 *
 * `authuser` names the mailbox by address, so a selected non-default account
 * never points at the browser's first signed-in account instead.
 */
function messageSourceUrl(
  messageId: string,
  accountEmail: string | null,
): string {
  const mailbox =
    accountEmail === null
      ? "https://mail.google.com/mail/u/0/"
      : `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(accountEmail)}`;
  return `${mailbox}#all/${encodeURIComponent(messageId)}`;
}

const OUTCOME_SEVERITY: Readonly<Record<MorningBriefBranchOutcome, number>> = {
  complete: 0,
  truncated: 1,
  denied: 2,
  failed: 3,
};

/** Coverage only ever degrades; the worst observed outcome is the honest one. */
function worstOutcome(
  left: MorningBriefBranchOutcome | null,
  right: MorningBriefBranchOutcome,
): MorningBriefBranchOutcome {
  if (left === null) {
    return right;
  }
  return OUTCOME_SEVERITY[left] >= OUTCOME_SEVERITY[right] ? left : right;
}

/**
 * Combine the delays advised across limited requests.
 *
 * The longest advice wins, so a caller that honors it never retries earlier
 * than a provider asked. Each value arrives already clamped by the shared
 * reader, which keeps the retained one inside that same bound.
 */
function longerDelay(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

function recordOutcome(
  state: CollectionState,
  outcome: MorningBriefReadOutcome<unknown>,
): MorningBriefBranchOutcome | null {
  switch (outcome.kind) {
    case "ok": {
      return null;
    }
    case "denied": {
      return "denied";
    }
    case "rate-limited": {
      // The limit is the fact; `Retry-After` is optional provider advice.
      // Deriving the classification from the delay alone reported a 429 that
      // carried no header as an ordinary provider failure.
      state.rateLimited = true;
      state.retryAfterMs = longerDelay(
        state.retryAfterMs,
        outcome.retryAfterMs,
      );
      state.failed = true;
      return "failed";
    }
    case "budget-exhausted": {
      state.truncations.add(outcome.limit);
      return "truncated";
    }
    case "too-large": {
      state.truncations.add("response-bytes");
      return "truncated";
    }
    case "not-found":
    case "malformed":
    case "provider-failed":
    case "revoked": {
      state.failed = true;
      return "failed";
    }
  }
}

/**
 * Provider `after`/`before` are second-resolution, so the query is widened to
 * whole seconds and every candidate is rechecked against millisecond
 * `internalDate`. List order is not assumed.
 */
function recentQuery(from: Date, to: Date): string {
  const after = Math.floor(from.getTime() / 1000);
  const before = Math.ceil(to.getTime() / 1000) + 1;
  return `after:${after} before:${before}`;
}

async function collectBranchCandidates(
  reader: MorningBriefConnectorReader,
  state: CollectionState,
  query: string,
): Promise<BranchResult> {
  const candidates: BranchCandidate[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let outcome: MorningBriefBranchOutcome = "complete";

  for (
    let page = 0;
    page < GMAIL_COLLECTION_CAPS.listPagesPerBranch;
    page += 1
  ) {
    const result = await reader.getJson({
      pathname: "messages",
      query: {
        q: query,
        maxResults: String(GMAIL_COLLECTION_CAPS.candidatesPerPage),
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      schema: gmailListResponseSchema,
    });
    const failure = recordOutcome(state, result);
    if (failure !== null || result.kind !== "ok") {
      return { candidates, outcome: failure ?? "failed" };
    }
    for (const message of result.value.messages ?? []) {
      if (seen.has(message.id)) {
        continue;
      }
      seen.add(message.id);
      candidates.push(message);
    }
    pageToken = result.value.nextPageToken;
    // An empty page that still carries a continuation token is a real Gmail
    // response, so paging continues rather than stopping on an empty list.
    if (pageToken === undefined) {
      return { candidates, outcome };
    }
  }
  if (pageToken !== undefined) {
    state.truncations.add("list-pages");
    outcome = "truncated";
  }
  return { candidates, outcome };
}

/**
 * Interleave the branches so the unread backlog always gets a share of the
 * detail budget instead of starving behind a busy recent window.
 */
function interleaveDetailTargets(
  branchCandidates: ReadonlyMap<
    MorningBriefGmailBranch,
    readonly BranchCandidate[]
  >,
): readonly BranchCandidate[] {
  const cursors = new Map<MorningBriefGmailBranch, number>(
    BRANCHES.map((branch) => {
      return [branch, 0];
    }),
  );
  const ordered: BranchCandidate[] = [];
  const seen = new Set<string>();
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const branch of BRANCHES) {
      const list = branchCandidates.get(branch) ?? [];
      const cursor = cursors.get(branch) ?? 0;
      if (cursor >= list.length) {
        continue;
      }
      cursors.set(branch, cursor + 1);
      advanced = true;
      const candidate = list[cursor];
      if (!candidate || seen.has(candidate.id)) {
        continue;
      }
      seen.add(candidate.id);
      ordered.push(candidate);
    }
  }
  return ordered;
}

async function fetchMessageDetails(
  reader: MorningBriefConnectorReader,
  state: CollectionState,
  targets: readonly BranchCandidate[],
): Promise<ReadonlyMap<string, GmailMessage>> {
  const messages = new Map<string, GmailMessage>();
  let cursor = 0;
  let stop = false;

  async function worker(): Promise<void> {
    while (!stop) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      if (!target) {
        return;
      }
      if (state.detailRequests >= GMAIL_COLLECTION_CAPS.maxDetailRequests) {
        state.truncations.add("detail-requests");
        stop = true;
        return;
      }
      state.detailRequests += 1;
      const result = await reader.getJson({
        pathname: `messages/${encodeURIComponent(target.id)}`,
        query: { format: "full" },
        schema: gmailMessageSchema,
      });
      if (result.kind === "ok") {
        messages.set(result.value.id, result.value);
        continue;
      }
      if (result.kind === "not-found") {
        // The message was deleted between listing and reading. That is a real
        // gap in this message, not a failure of the branch.
        continue;
      }
      const failure = recordOutcome(state, result);
      if (failure !== null) {
        state.detailOutcome = worstOutcome(state.detailOutcome, failure);
      }
      if (result.kind === "budget-exhausted" || result.kind === "revoked") {
        stop = true;
        return;
      }
      if (failure === "failed") {
        stop = true;
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: GMAIL_COLLECTION_CAPS.concurrency }, () => {
      return worker();
    }),
  );
  return messages;
}

function branchesForMessage(
  message: GmailMessage,
  recentIds: ReadonlySet<string>,
  unreadIds: ReadonlySet<string>,
  window: { readonly from: Date; readonly to: Date },
): MorningBriefGmailBranch[] {
  const inWindow =
    message.internalDate >= window.from.getTime() &&
    message.internalDate < window.to.getTime();
  const branches: MorningBriefGmailBranch[] = [];
  if (recentIds.has(message.id) && inWindow) {
    branches.push("recent");
  }
  if (unreadIds.has(message.id)) {
    branches.push("unread");
  }
  return branches;
}

/** What is left of the shared normalized-text budget. */
interface TextBudget {
  remaining: number;
}

/**
 * Charge one retained value to the shared budget.
 *
 * Every character a collection keeps is charged here, headers included, so no
 * single transport-valid field can carry the result past the promised aggregate
 * bound. A value that no longer fits is shortened to what remains and the
 * shortfall is reported, rather than dropping the item that owns it.
 */
function retainText(
  value: string,
  budget: TextBudget,
  truncations: Set<MorningBriefTruncation>,
): string {
  if (value.length <= budget.remaining) {
    budget.remaining -= value.length;
    return value;
  }
  const kept = value.slice(0, budget.remaining);
  budget.remaining = 0;
  truncations.add("text-characters");
  return kept;
}

/** Project one header to its own ceiling, then charge it to the budget. */
function retainHeader(
  value: string | null,
  limit: number,
  budget: TextBudget,
  truncations: Set<MorningBriefTruncation>,
): string | null {
  if (value === null) {
    return null;
  }
  if (value.length <= limit) {
    return retainText(value, budget, truncations);
  }
  truncations.add("header-characters");
  return retainText(value.slice(0, limit), budget, truncations);
}

/** Normalize merged messages under the final text budget, newest first. */
function normalizeItems(args: {
  readonly messages: ReadonlyMap<string, GmailMessage>;
  readonly recentIds: ReadonlySet<string>;
  readonly unreadIds: ReadonlySet<string>;
  readonly window: { readonly from: Date; readonly to: Date };
  readonly accountEmail: string | null;
  readonly state: CollectionState;
}): MorningBriefGmailItem[] {
  const items: MorningBriefGmailItem[] = [];
  const truncations = args.state.truncations;
  const budget: TextBudget = {
    remaining: GMAIL_COLLECTION_CAPS.maxTextCharacters,
  };
  for (const message of args.messages.values()) {
    const branches = branchesForMessage(
      message,
      args.recentIds,
      args.unreadIds,
      args.window,
    );
    if (branches.length === 0) {
      continue;
    }
    const excerptResult = messageExcerpt(message);
    if (excerptResult.truncated) {
      truncations.add("excerpt-characters");
    }
    if (excerptResult.mimeTruncated) {
      truncations.add("mime-nodes");
    }
    // Charged in the order the item presents them: the headers that identify a
    // message first, then its excerpt.
    const subject = retainHeader(
      headerValue(message, "subject"),
      GMAIL_HEADER_CHARACTER_CAPS.subject,
      budget,
      truncations,
    );
    const from = retainHeader(
      headerValue(message, "from"),
      GMAIL_HEADER_CHARACTER_CAPS.from,
      budget,
      truncations,
    );
    const to = retainHeader(
      headerValue(message, "to"),
      GMAIL_HEADER_CHARACTER_CAPS.to,
      budget,
      truncations,
    );
    const date = retainHeader(
      headerValue(message, "date"),
      GMAIL_HEADER_CHARACTER_CAPS.date,
      budget,
      truncations,
    );
    items.push({
      messageId: message.id,
      threadId: message.threadId,
      branches,
      subject,
      from,
      to,
      date,
      internalDate: new Date(message.internalDate).toISOString(),
      unread: (message.labelIds ?? []).includes("UNREAD"),
      excerpt: retainText(excerptResult.excerpt, budget, truncations),
      excerptSource: excerptResult.source,
      sourceUrl: messageSourceUrl(message.id, args.accountEmail),
    });
  }
  return items.sort((left, right) => {
    return right.internalDate.localeCompare(left.internalDate);
  });
}

/** The envelope for a source that produced nothing usable at all. */
function unavailableCollection(args: {
  readonly scope: MorningBriefCollectionScope;
  readonly window: { readonly from: Date; readonly to: Date };
  readonly collectedAt: Date;
  readonly failure: MorningBriefGmailCollection["failure"];
}): MorningBriefGmailCollection {
  return {
    source: "gmail",
    status: "unavailable",
    // A source that never became readable has no observed mailbox.
    accountEmail: null,
    anchor: args.scope.anchor.toISOString(),
    collectedAt: args.collectedAt.toISOString(),
    timezone: args.scope.timezone,
    recentWindow: {
      from: args.window.from.toISOString(),
      to: args.window.to.toISOString(),
    },
    unreadObservedAt: args.collectedAt.toISOString(),
    items: [],
    coverage: {
      recent: "failed",
      unread: "failed",
      truncations: [],
      requests: 0,
      retryAfterMs: null,
    },
    failure: args.failure,
  };
}

export async function collectMorningBriefGmail(
  args: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
  },
  signal: AbortSignal,
): Promise<MorningBriefGmailCollection> {
  const { scope } = args;
  const window = {
    from: new Date(
      scope.anchor.getTime() - GMAIL_COLLECTION_CAPS.recentWindowMs,
    ),
    to: scope.anchor,
  };
  const collectedAt = nowDate();
  const state: CollectionState = {
    truncations: new Set(),
    detailRequests: 0,
    retryAfterMs: null,
    rateLimited: false,
    failed: false,
    detailOutcome: null,
  };

  const access = await withMorningBriefConnectorReader(
    {
      scope,
      connectorSlug: GMAIL_CONNECTOR_SLUG,
      apiBase: GMAIL_API_BASE,
      environmentName: GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
      budget: {
        maxRequests: GMAIL_COLLECTION_CAPS.maxRequests,
        maxResponseBytes: GMAIL_COLLECTION_CAPS.maxResponseBytes,
        maxTotalResponseBytes: GMAIL_COLLECTION_CAPS.maxTotalResponseBytes,
        deadlineMs: GMAIL_COLLECTION_CAPS.deadlineMs,
      },
      db: args.db,
      clerk: args.clerk,
    },
    async (reader) => {
      const recent = await collectBranchCandidates(
        reader,
        state,
        recentQuery(window.from, window.to),
      );
      const unread = await collectBranchCandidates(reader, state, "is:unread");
      const targets = interleaveDetailTargets(
        new Map([
          ["recent", recent.candidates],
          ["unread", unread.candidates],
        ]),
      );
      const messages = await fetchMessageDetails(reader, state, targets);
      return { recent, unread, messages, accountEmail: reader.accountEmail };
    },
    signal,
  );

  if (access.kind === "unavailable") {
    return unavailableCollection({
      scope,
      window,
      collectedAt,
      failure: access.reason,
    });
  }

  const { recent, unread, messages, accountEmail } = access.value;
  if (access.truncatedTotalBytes) {
    state.truncations.add("total-response-bytes");
  }
  const recentIds = new Set(
    recent.candidates.map((candidate) => {
      return candidate.id;
    }),
  );
  const unreadIds = new Set(
    unread.candidates.map((candidate) => {
      return candidate.id;
    }),
  );

  const items = normalizeItems({
    messages,
    recentIds,
    unreadIds,
    window,
    accountEmail,
    state,
  });

  const coverage = {
    recent: worstOutcome(recent.outcome, state.detailOutcome ?? "complete"),
    unread: worstOutcome(unread.outcome, state.detailOutcome ?? "complete"),
    truncations: [...state.truncations].sort(),
    requests: access.requests,
    retryAfterMs: state.retryAfterMs,
  };
  const status = collectionStatus(items.length, coverage, state.failed);
  return {
    source: "gmail",
    status,
    accountEmail,
    anchor: scope.anchor.toISOString(),
    collectedAt: collectedAt.toISOString(),
    timezone: scope.timezone,
    recentWindow: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    unreadObservedAt: collectedAt.toISOString(),
    items,
    coverage,
    // Branch-level trouble that produced no usable content is reported as a
    // source failure, so an unreadable day can never look like an empty one.
    failure: state.rateLimited
      ? "rate-limited"
      : status === "unavailable" && state.failed
        ? "provider-failed"
        : null,
  };
}

/**
 * A cap, a denied branch, an unreadable page or a provider failure is never a
 * healthy empty day. Only a complete read with nothing in it is `empty`.
 */
function collectionStatus(
  itemCount: number,
  coverage: {
    readonly recent: MorningBriefBranchOutcome;
    readonly unread: MorningBriefBranchOutcome;
    readonly truncations: readonly MorningBriefTruncation[];
  },
  failed: boolean,
): MorningBriefGmailCollection["status"] {
  const complete =
    coverage.recent === "complete" &&
    coverage.unread === "complete" &&
    coverage.truncations.length === 0 &&
    !failed;
  if (complete) {
    return itemCount > 0 ? "ok" : "empty";
  }
  return itemCount > 0 ? "partial" : "unavailable";
}

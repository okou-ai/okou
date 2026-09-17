#!/usr/bin/env tsx

import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import {
  serializeChatFollowupsContent,
  type ChatRecommendedFollowup,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import {
  chatEvents,
  type ChatEventUsagePayload,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { closeDbPool, db } from "../lib/db";
import { optionalEnv } from "../lib/env";
import { normalizeRunMetadata } from "../signals/services/agent-run-metadata-write.service";
import { webChatPublicBrandContextId } from "../signals/services/web-chat-public-brand-context.service";
import { onRejection } from "../signals/utils";

const BULK_INSERT_CHUNK = 500;
const SCRIPT_MARKER = "dev-bench-seed";
const ALLOW_NON_LOCAL_ENV = "DEV_BENCH_SEED_ALLOW_NON_LOCAL";

type Database = ReturnType<typeof db>;
type AgentRunInsert = typeof agentRuns.$inferInsert;
type ChatEventInsert = typeof chatEvents.$inferInsert;
type SeedChatEventRow = Omit<
  ChatEventInsert,
  "role" | "runLifecycleEvent" | "seqId"
> & {
  id: string;
  createdAt: Date;
  sequenceNumber?: number | null;
  seqId?: number;
};

export interface BuiltProfileRows {
  readonly runRows: AgentRunInsert[];
  readonly eventRows: SeedChatEventRow[];
}

export interface BuildProfileRowsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly profile: ThreadProfile;
}

interface BucketSpec {
  readonly name: string;
  readonly count: number;
  readonly min: number;
  readonly max: number;
}

interface FixedRunCount {
  readonly count: number;
  readonly bucketName: string;
}

interface WorkflowAutomationSpec {
  readonly triggerBrief: string;
  readonly count: number;
}

export interface ThreadProfile {
  readonly slug: string;
  readonly title: string;
  readonly selectedModel: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly targetRunRows: number;
  readonly nullRunControlRows: number;
  readonly buckets: readonly BucketSpec[];
  readonly fixedRunCounts: readonly FixedRunCount[];
  readonly followupCount: number;
  readonly usageCount: number;
  readonly workflowAutomations: readonly WorkflowAutomationSpec[];
  readonly revokeCount: number;
  readonly failedRunCount: number;
  readonly runEventStyle: "mixed" | "items";
  readonly sequenceMax: number;
}

export const DEV_BENCH_THREAD_PROFILES: readonly ThreadProfile[] = [
  {
    slug: "feature-switch-digest",
    title: "[dev bench] prod-shaped chat thread A - 1.4k rows",
    selectedModel: "deepseek-v4-flash",
    startAt: "2026-05-10T00:05:02.553Z",
    endAt: "2026-06-23T01:34:51.637Z",
    targetRunRows: 1412,
    nullRunControlRows: 9,
    buckets: [
      { name: "1-5", count: 54, min: 3, max: 5 },
      { name: "6-10", count: 49, min: 6, max: 10 },
      { name: "11-25", count: 22, min: 11, max: 25 },
      { name: "26-50", count: 4, min: 26, max: 50 },
      { name: "51-100", count: 4, min: 51, max: 100 },
      { name: "101+", count: 1, min: 101, max: 147 },
    ],
    fixedRunCounts: [
      { bucketName: "101+", count: 147 },
      { bucketName: "51-100", count: 59 },
      { bucketName: "51-100", count: 59 },
      { bucketName: "51-100", count: 54 },
      { bucketName: "51-100", count: 53 },
      { bucketName: "26-50", count: 35 },
      { bucketName: "26-50", count: 33 },
      { bucketName: "26-50", count: 32 },
      { bucketName: "26-50", count: 26 },
      { bucketName: "11-25", count: 24 },
      { bucketName: "11-25", count: 23 },
      { bucketName: "11-25", count: 19 },
    ],
    followupCount: 72,
    usageCount: 32,
    workflowAutomations: [
      { triggerBrief: "pr-auto-16384", count: 5 },
      { triggerBrief: "main-feature-switch-digest", count: 22 },
      { triggerBrief: "pr-auto-17189", count: 8 },
      { triggerBrief: "pr-auto-17218", count: 6 },
      { triggerBrief: "pr-auto-17608", count: 5 },
    ],
    revokeCount: 6,
    failedRunCount: 1,
    runEventStyle: "mixed",
    sequenceMax: 5370,
  },
  {
    slug: "release-pr-auto-merge",
    title: "[dev bench] prod-shaped chat thread B - 2.8k rows",
    selectedModel: "gpt-5.6-luna",
    startAt: "2026-06-05T01:01:49.357Z",
    endAt: "2026-06-23T03:36:38.261Z",
    targetRunRows: 2821,
    nullRunControlRows: 0,
    buckets: [
      { name: "1-5", count: 2, min: 5, max: 5 },
      { name: "6-10", count: 67, min: 6, max: 10 },
      { name: "11-25", count: 38, min: 11, max: 25 },
      { name: "26-50", count: 23, min: 26, max: 50 },
      { name: "51-100", count: 10, min: 51, max: 100 },
      { name: "101+", count: 2, min: 101, max: 117 },
    ],
    fixedRunCounts: [
      { bucketName: "101+", count: 117 },
      { bucketName: "101+", count: 108 },
      { bucketName: "51-100", count: 77 },
      { bucketName: "51-100", count: 72 },
      { bucketName: "51-100", count: 63 },
      { bucketName: "51-100", count: 62 },
      { bucketName: "51-100", count: 61 },
      { bucketName: "51-100", count: 60 },
      { bucketName: "51-100", count: 59 },
      { bucketName: "51-100", count: 56 },
      { bucketName: "51-100", count: 56 },
      { bucketName: "51-100", count: 52 },
    ],
    followupCount: 142,
    usageCount: 0,
    workflowAutomations: [
      { triggerBrief: "release-pr-auto-merge", count: 134 },
      { triggerBrief: "verify-auto-merge-status", count: 1 },
    ],
    revokeCount: 6,
    failedRunCount: 0,
    runEventStyle: "items",
    sequenceMax: 280,
  },
];

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

function usage(): never {
  throw new Error(
    [
      "Usage: pnpm --filter api db:dev-bench-seed -- <userId> <agentId>",
      "",
      "Seeds two prod-shaped chat threads for local chat-thread performance work.",
      `Set ${ALLOW_NON_LOCAL_ENV}=1 only if you intentionally want to run against a non-local database.`,
    ].join("\n"),
  );
}

function assertLocalDatabase(): void {
  if (optionalEnv(ALLOW_NON_LOCAL_ENV) === "1") {
    return;
  }

  const rawUrl = optionalEnv("DATABASE_URL");
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const { hostname } = new URL(rawUrl);
  const localHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "postgres",
    "db",
  ]);
  if (!localHosts.has(hostname) && !hostname.endsWith(".local")) {
    throw new Error(
      `Refusing to seed non-local database host "${hostname}". Set ${ALLOW_NON_LOCAL_ENV}=1 to override.`,
    );
  }
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createRandom(seed: string): () => number {
  let state = Number.parseInt(stableHash(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function shuffle<T>(items: readonly T[], seed: string): T[] {
  const random = createRandom(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

function bucketForCount(
  buckets: readonly BucketSpec[],
  bucketName: string,
): BucketSpec {
  const bucket = buckets.find((item) => {
    return item.name === bucketName;
  });
  if (!bucket) {
    throw new Error(`Unknown run-count bucket "${bucketName}"`);
  }
  return bucket;
}

function buildRunCounts(profile: ThreadProfile): number[] {
  const remainingBuckets = new Map(
    profile.buckets.map((bucket) => {
      return [bucket.name, bucket.count];
    }),
  );
  const rows: { count: number; bucket: BucketSpec }[] = [];

  for (const fixed of profile.fixedRunCounts) {
    const bucket = bucketForCount(profile.buckets, fixed.bucketName);
    const remaining = remainingBuckets.get(bucket.name) ?? 0;
    if (remaining <= 0) {
      throw new Error(`Too many fixed counts for bucket "${bucket.name}"`);
    }
    if (fixed.count < bucket.min || fixed.count > bucket.max) {
      throw new Error(
        `Fixed count ${String(fixed.count)} is outside bucket "${bucket.name}"`,
      );
    }
    remainingBuckets.set(bucket.name, remaining - 1);
    rows.push({ count: fixed.count, bucket });
  }

  for (const bucket of profile.buckets) {
    const remaining = remainingBuckets.get(bucket.name) ?? 0;
    for (let i = 0; i < remaining; i++) {
      rows.push({ count: bucket.min, bucket });
    }
  }

  let currentTotal = rows.reduce((sum, row) => {
    return sum + row.count;
  }, 0);
  let extra = profile.targetRunRows - currentTotal;
  if (extra < 0) {
    throw new Error(
      `${profile.slug} fixed run counts exceed target row count by ${String(-extra)}`,
    );
  }

  const adjustableRows = shuffle(rows, `${profile.slug}:adjust`);
  while (extra > 0) {
    let changed = false;
    for (const row of adjustableRows) {
      if (row.count >= row.bucket.max) {
        continue;
      }
      row.count++;
      extra--;
      changed = true;
      if (extra === 0) {
        break;
      }
    }
    if (!changed) {
      throw new Error(`${profile.slug} buckets cannot reach target row count`);
    }
  }

  currentTotal = rows.reduce((sum, row) => {
    return sum + row.count;
  }, 0);
  if (currentTotal !== profile.targetRunRows) {
    throw new Error(
      `${profile.slug} generated ${String(currentTotal)} run rows, expected ${String(profile.targetRunRows)}`,
    );
  }

  return shuffle(
    rows.map((row) => {
      return row.count;
    }),
    `${profile.slug}:chronology`,
  );
}

function buildWorkflowAutomationBriefs(
  profile: ThreadProfile,
): readonly (string | null)[] {
  return shuffle(
    profile.workflowAutomations.flatMap((spec) => {
      return Array.from({ length: spec.count }, () => {
        return spec.triggerBrief;
      });
    }),
    `${profile.slug}:workflow-automation`,
  );
}

function interpolateDate(start: Date, end: Date, index: number, total: number) {
  if (total <= 1) {
    return start;
  }
  const ratio = index / (total - 1);
  return new Date(start.getTime() + (end.getTime() - start.getTime()) * ratio);
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function loremParagraph(seed: number): string {
  const clauses = [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit",
    "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua",
    "ut enim ad minim veniam, quis nostrud exercitation ullamco laboris",
    "nisi ut aliquip ex ea commodo consequat",
    "duis aute irure dolor in reprehenderit in voluptate velit esse",
    "cillum dolore eu fugiat nulla pariatur",
    "excepteur sint occaecat cupidatat non proident",
    "sunt in culpa qui officia deserunt mollit anim id est laborum",
  ];
  return Array.from({ length: 4 }, (_, index) => {
    return clauses[(seed + index) % clauses.length];
  }).join(", ");
}

function markdownLorem(
  profile: ThreadProfile,
  runIndex: number,
  eventIndex: number,
): string {
  const repeatedParagraphs = Array.from({ length: 3 }, (_, index) => {
    return loremParagraph(runIndex + eventIndex + index);
  }).join("\n\n");

  return [
    `### ${profile.slug} run ${String(runIndex)} event ${String(eventIndex)}`,
    "",
    repeatedParagraphs,
    "",
    "- Status: synthetic benchmark message",
    "- Shape: markdown body with bullets, inline `code`, and stable lorem text",
    "- Purpose: stress chat serialization, IndexedDB cache, and renderer paths",
    "",
    "```ts",
    `const event = { run: ${String(runIndex)}, message: ${String(eventIndex)}, profile: "${profile.slug}" };`,
    "console.log(event);",
    "```",
  ].join("\n");
}

function userPromptLorem(profile: ThreadProfile, runIndex: number): string {
  return [
    `Run ${String(runIndex)} for ${profile.slug}.`,
    loremParagraph(runIndex),
    "Please continue the thread and summarize the relevant state with concise markdown.",
  ].join("\n\n");
}

function runEventId(
  profile: ThreadProfile,
  runIndex: number,
  eventIndex: number,
): string {
  if (profile.runEventStyle === "items") {
    return `item_${String(eventIndex)}`;
  }
  if ((runIndex + eventIndex) % 3 === 0) {
    return `gen-${String(1_782_000_000 + runIndex)}-${stableHash(`${profile.slug}:gen:${runIndex}:${eventIndex}`).slice(0, 20)}`;
  }
  return `msg_${stableHash(`${profile.slug}:msg:${runIndex}:${eventIndex}`).slice(0, 24)}`;
}

function sequenceNumberFor(
  profile: ThreadProfile,
  runIndex: number,
  eventIndex: number,
  eventCount: number,
): number {
  if (eventCount <= 1) {
    return Math.min(profile.sequenceMax, 2 + runIndex);
  }
  const baseMax =
    profile.runEventStyle === "mixed" && runIndex % 29 === 0
      ? profile.sequenceMax
      : Math.max(12, Math.min(profile.sequenceMax, eventCount * 4 + 8));
  const ratio = eventIndex / (eventCount - 1);
  return Math.max(1, Math.round(2 + ratio * (baseMax - 2)));
}

function followups(
  profile: ThreadProfile,
  runIndex: number,
): ChatRecommendedFollowup[] {
  return [
    {
      kind: "talk",
      prompt: `Summarize the benchmark thread ${profile.slug} at run ${String(runIndex)}.`,
    },
    {
      kind: "talk",
      prompt: "List the latest run status changes in markdown bullets.",
    },
    {
      kind: "talk",
      prompt: "Compare this run with the previous synthetic checkpoint.",
    },
  ];
}

function usagePayload(
  profile: ThreadProfile,
  runIndex: number,
  settledAt: Date,
): ChatEventUsagePayload {
  const kind = runIndex % 9 === 0 ? "image" : "model";
  const provider =
    kind === "image" ? "fal-ai/nano-banana-2" : profile.selectedModel;
  const credits = kind === "image" ? 96 : 220 + (runIndex % 90);
  return {
    version: 1,
    totalCredits: credits,
    settledAt: settledAt.toISOString(),
    breakdown: [
      {
        kind,
        credits,
        providers: [{ provider, credits }],
      },
    ],
  };
}

async function chunkedInsert<T>(
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += BULK_INSERT_CHUNK) {
    const chunk = rows.slice(index, index + BULK_INSERT_CHUNK);
    if (chunk.length > 0) {
      await insert([...chunk]);
    }
  }
}

async function cleanupExistingBenchThreads(
  database: Database,
  args: { readonly userId: string; readonly agentId: string },
): Promise<number> {
  const threadRows = await database
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentId, args.agentId),
        inArray(
          chatThreads.title,
          DEV_BENCH_THREAD_PROFILES.map((profile) => {
            return profile.title;
          }),
        ),
      ),
    );

  const threadIds = threadRows.map((row) => {
    return row.id;
  });
  if (threadIds.length === 0) {
    return 0;
  }

  const runRows = await database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.chatThreadId, threadIds),
        isNotNull(agentRuns.triggerSource),
      ),
    );
  const runIds = runRows.map((row) => {
    return row.id;
  });
  const sessionRows =
    runIds.length === 0
      ? []
      : await database
          .select({ id: agentRuns.sessionId })
          .from(agentRuns)
          .where(inArray(agentRuns.id, runIds));
  const sessionIds = [
    ...new Set(
      sessionRows.map((row) => {
        return row.id;
      }),
    ),
  ];

  await database
    .delete(chatEvents)
    .where(inArray(chatEvents.chatThreadId, threadIds));
  if (runIds.length > 0) {
    await database.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  }
  if (sessionIds.length > 0) {
    await database
      .delete(agentSessions)
      .where(inArray(agentSessions.id, sessionIds));
  }
  await database.delete(chatThreads).where(inArray(chatThreads.id, threadIds));

  return threadIds.length;
}

async function getAgentOrgId(
  database: Database,
  agentId: string,
): Promise<string> {
  const [row] = await database
    .select({ orgId: agents.orgId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!row) {
    throw new Error(`Agent ${agentId} does not exist`);
  }
  return row.orgId;
}

function appendRunEvents(
  args: BuildProfileRowsArgs & {
    readonly runIndex: number;
    readonly runRowCount: number;
    readonly runCount: number;
    readonly workflowAutomationBrief: string | null;
    readonly startAt: Date;
    readonly endAt: Date;
    readonly rows: BuiltProfileRows;
    readonly runUserMessageRows: SeedChatEventRow[];
  },
): void {
  const runId = randomUUID();
  const hasUsage = args.runIndex < args.profile.usageCount;
  const hasFollowups = args.runIndex < args.profile.followupCount;
  const eventCount = Math.max(
    1,
    args.runRowCount - 2 - (hasUsage ? 1 : 0) - (hasFollowups ? 1 : 0),
  );
  const baseCreatedAt = interpolateDate(
    args.startAt,
    args.endAt,
    args.runIndex,
    args.runCount,
  );
  const failed = args.runIndex < args.profile.failedRunCount;
  const prompt = userPromptLorem(args.profile, args.runIndex);
  const userMessage = {
    version: 1 as const,
    parts: [{ type: "text" as const, text: prompt }],
  };
  const userMessageRow: SeedChatEventRow = {
    id: randomUUID(),
    chatThreadId: args.threadId,
    runId,
    eventType: "input.prompt",
    contextType: args.workflowAutomationBrief ? "automation" : "web",
    payload: { userMessage },
    createdAt: baseCreatedAt,
  };

  args.runUserMessageRows.push(userMessageRow);
  args.rows.eventRows.push(userMessageRow);
  const metadata = normalizeRunMetadata({
    triggerSource: args.workflowAutomationBrief ? "automation-schedule" : "web",
    selectedModel: args.profile.selectedModel,
    chatThreadId: args.threadId,
    summary: `Synthetic ${args.profile.slug} run ${String(args.runIndex)}`,
    triggerBrief: args.workflowAutomationBrief,
  });
  args.rows.runRows.push({
    id: runId,
    userId: args.userId,
    orgId: args.orgId,
    sessionId: args.sessionId,
    status: failed ? "failed" : "completed",
    prompt,
    result: failed
      ? null
      : {
          agentSessionId: `${SCRIPT_MARKER}-${args.profile.slug}-${args.runIndex}`,
        },
    error: failed ? "Synthetic benchmark failure" : null,
    lastEventSequence: args.profile.sequenceMax,
    createdAt: baseCreatedAt,
    startedAt: addMs(baseCreatedAt, 1000),
    completedAt: addMs(baseCreatedAt, 45_000 + eventCount * 100),
    ...metadata,
  });

  appendAssistantEvents({
    profile: args.profile,
    threadId: args.threadId,
    runId,
    runIndex: args.runIndex,
    eventCount,
    baseCreatedAt,
    eventRows: args.rows.eventRows,
  });
  appendUsageEvent({
    profile: args.profile,
    threadId: args.threadId,
    runId,
    runIndex: args.runIndex,
    eventCount,
    baseCreatedAt,
    hasUsage,
    eventRows: args.rows.eventRows,
  });
  appendLifecycleEvent({
    profile: args.profile,
    threadId: args.threadId,
    runId,
    runIndex: args.runIndex,
    eventCount,
    baseCreatedAt,
    failed,
    eventRows: args.rows.eventRows,
  });
  appendFollowupsEvent({
    profile: args.profile,
    threadId: args.threadId,
    runId,
    runIndex: args.runIndex,
    eventCount,
    baseCreatedAt,
    hasFollowups,
    eventRows: args.rows.eventRows,
  });
}

function appendAssistantEvents(args: {
  readonly profile: ThreadProfile;
  readonly threadId: string;
  readonly runId: string;
  readonly runIndex: number;
  readonly eventCount: number;
  readonly baseCreatedAt: Date;
  readonly eventRows: SeedChatEventRow[];
}): void {
  for (let eventIndex = 0; eventIndex < args.eventCount; eventIndex++) {
    const sequenceNumber = sequenceNumberFor(
      args.profile,
      args.runIndex,
      eventIndex,
      args.eventCount,
    );
    args.eventRows.push({
      id: randomUUID(),
      chatThreadId: args.threadId,
      runId: args.runId,
      eventType: "output.message",
      payload: {
        content: markdownLorem(args.profile, args.runIndex, eventIndex),
      },
      sequenceNumber,
      runEventId: runEventId(args.profile, args.runIndex, sequenceNumber),
      createdAt: addMs(args.baseCreatedAt, 10_000 + eventIndex * 750),
    });
  }
}

function appendUsageEvent(args: {
  readonly profile: ThreadProfile;
  readonly threadId: string;
  readonly runId: string;
  readonly runIndex: number;
  readonly eventCount: number;
  readonly baseCreatedAt: Date;
  readonly hasUsage: boolean;
  readonly eventRows: SeedChatEventRow[];
}): void {
  if (!args.hasUsage) {
    return;
  }
  const createdAt = addMs(args.baseCreatedAt, 44_000 + args.eventCount * 100);
  const usage = usagePayload(args.profile, args.runIndex, createdAt);
  args.eventRows.push({
    id: randomUUID(),
    chatThreadId: args.threadId,
    runId: args.runId,
    eventType: "usage.recorded",
    payload: { usage },
    createdAt,
  });
}

function appendLifecycleEvent(args: {
  readonly profile: ThreadProfile;
  readonly threadId: string;
  readonly runId: string;
  readonly runIndex: number;
  readonly eventCount: number;
  readonly baseCreatedAt: Date;
  readonly failed: boolean;
  readonly eventRows: SeedChatEventRow[];
}): void {
  args.eventRows.push({
    id: randomUUID(),
    chatThreadId: args.threadId,
    runId: args.runId,
    eventType: args.failed ? "run.failed" : "run.completed",
    payload: args.failed ? { error: "Synthetic benchmark failure" } : null,
    createdAt: addMs(args.baseCreatedAt, 45_000 + args.eventCount * 100),
  });
}

function appendFollowupsEvent(args: {
  readonly profile: ThreadProfile;
  readonly threadId: string;
  readonly runId: string;
  readonly runIndex: number;
  readonly eventCount: number;
  readonly baseCreatedAt: Date;
  readonly hasFollowups: boolean;
  readonly eventRows: SeedChatEventRow[];
}): void {
  if (!args.hasFollowups) {
    return;
  }
  args.eventRows.push({
    id: randomUUID(),
    chatThreadId: args.threadId,
    runId: args.runId,
    eventType: "output.followups",
    payload: {
      content: serializeChatFollowupsContent(
        followups(args.profile, args.runIndex),
      ),
    },
    createdAt: addMs(args.baseCreatedAt, 45_001 + args.eventCount * 100),
  });
}

function appendNullRunControlRows(args: {
  readonly profile: ThreadProfile;
  readonly threadId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly eventRows: SeedChatEventRow[];
}): void {
  for (
    let controlIndex = 0;
    controlIndex < args.profile.nullRunControlRows;
    controlIndex++
  ) {
    const createdAt = addMs(
      interpolateDate(
        args.startAt,
        args.endAt,
        controlIndex + 1,
        args.profile.nullRunControlRows + 2,
      ),
      500,
    );
    const prompt = userPromptLorem(args.profile, controlIndex);
    const isInputPrompt = controlIndex % 2 === 0;
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: prompt }],
    };
    args.eventRows.push({
      id: randomUUID(),
      chatThreadId: args.threadId,
      runId: null,
      eventType: isInputPrompt ? "input.prompt" : "output.thinking",
      ...(isInputPrompt
        ? {
            contextType: "web",
            contextId: webChatPublicBrandContextId(PUBLIC_BRAND),
            payload: { userMessage },
          }
        : {
            payload: {
              thinking: `Synthetic background state ${String(controlIndex)}`,
            },
          }),
      createdAt,
    });
  }
}

function applyRevokeMarkers(
  profile: ThreadProfile,
  runUserMessageRows: readonly SeedChatEventRow[],
): void {
  for (
    let revokeIndex = 0;
    revokeIndex < profile.revokeCount &&
    revokeIndex + 1 < runUserMessageRows.length;
    revokeIndex++
  ) {
    const targetId = runUserMessageRows[revokeIndex]?.id;
    const revokerIndex = Math.min(
      runUserMessageRows.length - 1,
      revokeIndex +
        Math.floor(runUserMessageRows.length / (profile.revokeCount + 1)),
    );
    const revoker = runUserMessageRows[revokerIndex];
    if (targetId && revoker) {
      revoker.revokesEventId = targetId;
    }
  }
}

function sortEventRows(eventRows: SeedChatEventRow[]): void {
  eventRows.sort((left, right) => {
    const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime();
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }
    return (left.sequenceNumber ?? -1) - (right.sequenceNumber ?? -1);
  });
  for (const [index, event] of eventRows.entries()) {
    event.seqId = index + 1;
  }
}

export function buildProfileRows(args: BuildProfileRowsArgs): BuiltProfileRows {
  const startAt = new Date(args.profile.startAt);
  const endAt = new Date(args.profile.endAt);
  const runCounts = buildRunCounts(args.profile);
  const workflowAutomationBriefs = buildWorkflowAutomationBriefs(args.profile);
  const rows: BuiltProfileRows = {
    runRows: [],
    eventRows: [],
  };
  const runUserMessageRows: SeedChatEventRow[] = [];

  for (let runIndex = 0; runIndex < runCounts.length; runIndex++) {
    appendRunEvents({
      ...args,
      runIndex,
      runRowCount: runCounts[runIndex]!,
      runCount: runCounts.length,
      workflowAutomationBrief: workflowAutomationBriefs[runIndex] ?? null,
      startAt,
      endAt,
      rows,
      runUserMessageRows,
    });
  }
  appendNullRunControlRows({
    profile: args.profile,
    threadId: args.threadId,
    startAt,
    endAt,
    eventRows: rows.eventRows,
  });
  applyRevokeMarkers(args.profile, runUserMessageRows);
  sortEventRows(rows.eventRows);
  return rows;
}

async function insertProfileRows(
  database: Database,
  rows: BuiltProfileRows,
): Promise<void> {
  await chunkedInsert(rows.runRows, (chunk) => {
    return database.insert(agentRuns).values(chunk);
  });
  const eventRows = rows.eventRows.map((row) => {
    const seqId = row.seqId;
    if (seqId === undefined) {
      throw new Error(`benchmark message ${row.id} has no seq_id`);
    }
    return { ...row, seqId };
  });
  await chunkedInsert(eventRows, (chunk) => {
    return database.insert(chatEvents).values(chunk);
  });
  const lastEvent = eventRows.at(-1);
  if (lastEvent) {
    await database
      .update(chatThreads)
      .set({ lastChatEventSeqId: lastEvent.seqId })
      .where(eq(chatThreads.id, lastEvent.chatThreadId));
  }
}

async function seedProfile(
  database: Database,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly profile: ThreadProfile;
  },
): Promise<{ readonly threadId: string; readonly eventCount: number }> {
  const threadId = randomUUID();
  const sessionId = randomUUID();
  const startAt = new Date(args.profile.startAt);
  const endAt = new Date(args.profile.endAt);
  const pinnedAt = addMs(startAt, 2000);
  const renamedAt = addMs(startAt, 250_000);

  await database.insert(agentSessions).values({
    id: sessionId,
    userId: args.userId,
    orgId: args.orgId,
    agentId: args.agentId,
  });

  await database.insert(chatThreads).values({
    id: threadId,
    userId: args.userId,
    agentId: args.agentId,
    title: args.profile.title,
    selectedModel: args.profile.selectedModel,
    pinnedAt,
    renamedAt,
    createdAt: addMs(startAt, -4000),
    updatedAt: addMs(endAt, 33),
    lastMessageAt: addMs(endAt, 33),
  });

  const rows = buildProfileRows({ ...args, threadId, sessionId });
  await insertProfileRows(database, rows);

  const lastReadRow =
    rows.eventRows[Math.floor(rows.eventRows.length * 0.6)] ??
    rows.eventRows[0];
  await database
    .update(chatThreads)
    .set({
      lastReadAt: lastReadRow?.createdAt ?? null,
      lastMessageAt:
        rows.eventRows[rows.eventRows.length - 1]?.createdAt ?? endAt,
      updatedAt: endAt,
    })
    .where(eq(chatThreads.id, threadId));

  return { threadId, eventCount: rows.eventRows.length };
}

async function seedDevBench(args: {
  readonly userId: string;
  readonly agentId: string;
}): Promise<void> {
  assertLocalDatabase();
  const database = db();
  const orgId = await getAgentOrgId(database, args.agentId);
  const removed = await cleanupExistingBenchThreads(database, args);
  if (removed > 0) {
    writeLine(`Removed ${String(removed)} existing dev bench thread(s)`);
  }

  const seeded = [];
  for (const profile of DEV_BENCH_THREAD_PROFILES) {
    const result = await seedProfile(database, {
      ...args,
      orgId,
      profile,
    });
    seeded.push({ profile, ...result });
  }

  await database.execute(sql`ANALYZE agent_runs, chat_threads, chat_events`);

  writeLine("Seeded prod-shaped chat benchmark threads:");
  for (const item of seeded) {
    writeLine(
      `- ${item.profile.title}: ${item.threadId} (${String(item.eventCount)} chat_messages)`,
    );
    writeLine(`  /chats/${item.threadId}`);
  }
}

async function main(): Promise<void> {
  const [userId, agentId] = process.argv.slice(2);
  if (!userId || !agentId) {
    usage();
  }
  await onRejection(seedDevBench({ userId, agentId }), closeDbPool);
  await closeDbPool();
}

if (isMainModule()) {
  await main();
}

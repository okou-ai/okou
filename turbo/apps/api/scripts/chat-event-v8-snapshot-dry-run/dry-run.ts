import { gunzipSync } from "node:zlib";

import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { z } from "zod";

import {
  PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION,
  upgradeChatEventSnapshotBody,
} from "../../src/signals/services/chat-event-snapshot-upgrade.service";

/**
 * Chat Event V8 transition code: a read-only production dry run of the V7 ->
 * V8 Snapshot upgrade over every stored `chat-events/` object. Removed in the
 * V8 plan's PR-3 together with the upgrade itself.
 *
 * Only counts, object keys, thread IDs, schema paths and schema messages leave
 * this module. Row content, payloads, message text and Goal briefs never do.
 */

export const CHAT_EVENT_SNAPSHOT_PREFIX = "chat-events/";

const MAX_EXAMPLES_PER_GROUP = 20;
const MAX_REASON_LENGTH = 200;

const SNAPSHOT_KEY_PATTERN =
  /^chat-events\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9]+(?:-r[0-9]+)?-[0-9a-f]{64}\.ndjson\.gz$/u;

/** Fixed messages thrown by the upgrade; none of them carries row content. */
const KNOWN_UPGRADE_MESSAGES = [
  "Chat Event snapshot must be newline-delimited JSON",
  "Chat Event snapshot contains invalid JSON",
  "Chat Event Snapshot is newer than this API",
  "Missing Chat Event Snapshot upgrade",
] as const;

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export interface DryRunFailure {
  readonly group: string;
  readonly path: string;
  readonly reason: string;
}

export type SnapshotInspection =
  | {
      readonly kind: "unrecognized-key";
    }
  | {
      readonly kind: "upgraded";
      readonly threadId: string;
      readonly rowsIn: number;
      readonly rowsOut: number;
      readonly changed: boolean;
    }
  | {
      readonly kind: "failed";
      readonly threadId: string;
      readonly failure: DryRunFailure;
    };

export function snapshotThreadId(key: string): string | null {
  return SNAPSHOT_KEY_PATTERN.exec(key)?.[1] ?? null;
}

function truncateReason(reason: string): string {
  return reason.length <= MAX_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_REASON_LENGTH)}…`;
}

function schemaPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "(row)";
  }
  return path
    .map((segment) => {
      return typeof segment === "number" ? "*" : String(segment);
    })
    .join(".");
}

/**
 * Classify an error without echoing its message unless the message is known
 * to be content-free: a SyntaxError from JSON.parse quotes the input text.
 */
export function classifyDryRunError(error: unknown): DryRunFailure {
  if (error instanceof z.ZodError) {
    const [issue] = error.issues;
    if (issue === undefined) {
      return { group: "schema:unknown", path: "(row)", reason: "ZodError" };
    }
    const path = schemaPath(issue.path);
    return {
      group: `schema:${issue.code}:${path}`,
      path,
      reason: truncateReason(issue.message),
    };
  }
  if (error instanceof Error) {
    const known = KNOWN_UPGRADE_MESSAGES.find((message) => {
      return error.message.startsWith(message);
    });
    if (known !== undefined) {
      return { group: `upgrade:${known}`, path: "(object)", reason: known };
    }
    return {
      group: `error:${error.name}`,
      path: "(object)",
      reason: error.name,
    };
  }
  return { group: "error:non-error", path: "(object)", reason: "non-error" };
}

function snapshotText(compressed: Buffer): Buffer {
  return compressed.subarray(0, 2).equals(GZIP_MAGIC)
    ? gunzipSync(compressed)
    : compressed;
}

function countRows(body: Buffer): number {
  const text = body.toString("utf8");
  return text.length === 0 ? 0 : text.split("\n").length - 1;
}

/**
 * Upgrade one stored object exactly as a V8 API would, then check the result
 * the way V8 readers do: strict row schema on every encoded line plus the
 * event projection.
 */
function upgradeAndVerify(body: Buffer): {
  readonly rowsOut: number;
  readonly changed: boolean;
} {
  const upgraded = upgradeChatEventSnapshotBody(
    body,
    PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION,
  );
  for (const row of upgraded.rows) {
    chatEventFromRow(chatEventRowSchema.parse(row));
  }
  const encoded = upgraded.body.toString("utf8");
  const lines = encoded.length === 0 ? [] : encoded.slice(0, -1).split("\n");
  for (const line of lines) {
    chatEventRowSchema.parse(JSON.parse(line));
  }
  return {
    rowsOut: upgraded.rows.length,
    changed: !upgraded.body.equals(body),
  };
}

export function inspectSnapshotObject(
  key: string,
  compressed: Buffer,
): SnapshotInspection {
  const threadId = snapshotThreadId(key);
  if (threadId === null) {
    return { kind: "unrecognized-key" };
  }
  const outcome = settleSync(() => {
    const body = snapshotText(compressed);
    const rowsIn = countRows(body);
    return { rowsIn, ...upgradeAndVerify(body) };
  });
  if (!outcome.ok) {
    return {
      kind: "failed",
      threadId,
      failure: classifyDryRunError(outcome.error),
    };
  }
  return { kind: "upgraded", threadId, ...outcome.value };
}

function settleSync<T>(
  run: () => T,
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

interface FailureGroup {
  count: number;
  readonly examples: {
    readonly threadId: string;
    readonly key: string;
    readonly path: string;
    readonly reason: string;
  }[];
}

export interface DryRunTally {
  objectsListed: number;
  objectsChecked: number;
  succeeded: number;
  failed: number;
  downloadFailed: number;
  unrecognizedKeys: number;
  objectsChanged: number;
  rowsIn: number;
  rowsOut: number;
  readonly unrecognizedKeyExamples: string[];
  readonly failureGroups: Map<string, FailureGroup>;
}

export function createDryRunTally(): DryRunTally {
  return {
    objectsListed: 0,
    objectsChecked: 0,
    succeeded: 0,
    failed: 0,
    downloadFailed: 0,
    unrecognizedKeys: 0,
    objectsChanged: 0,
    rowsIn: 0,
    rowsOut: 0,
    unrecognizedKeyExamples: [],
    failureGroups: new Map(),
  };
}

function recordFailure(
  tally: DryRunTally,
  key: string,
  threadId: string,
  failure: DryRunFailure,
): void {
  const group = tally.failureGroups.get(failure.group) ?? {
    count: 0,
    examples: [],
  };
  group.count += 1;
  if (group.examples.length < MAX_EXAMPLES_PER_GROUP) {
    group.examples.push({
      threadId,
      key,
      path: failure.path,
      reason: failure.reason,
    });
  }
  tally.failureGroups.set(failure.group, group);
}

export function recordInspection(
  tally: DryRunTally,
  key: string,
  inspection: SnapshotInspection,
): void {
  switch (inspection.kind) {
    case "unrecognized-key": {
      tally.unrecognizedKeys += 1;
      if (tally.unrecognizedKeyExamples.length < MAX_EXAMPLES_PER_GROUP) {
        tally.unrecognizedKeyExamples.push(key);
      }
      return;
    }
    case "upgraded": {
      tally.objectsChecked += 1;
      tally.succeeded += 1;
      tally.rowsIn += inspection.rowsIn;
      tally.rowsOut += inspection.rowsOut;
      if (inspection.changed) {
        tally.objectsChanged += 1;
      }
      return;
    }
    case "failed": {
      tally.objectsChecked += 1;
      tally.failed += 1;
      recordFailure(tally, key, inspection.threadId, inspection.failure);
      return;
    }
  }
}

/** A GET that still failed after its retries; the object was not inspected. */
export function recordDownloadFailure(
  tally: DryRunTally,
  key: string,
  error: unknown,
): void {
  tally.downloadFailed += 1;
  const failure = classifyDryRunError(error);
  recordFailure(tally, key, snapshotThreadId(key) ?? "(unknown)", {
    ...failure,
    group: `download:${failure.group}`,
  });
}

export interface DryRunSummary {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly prefix: string;
  readonly sourceVersion: number;
  readonly objectsListed: number;
  readonly objectsChecked: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly downloadFailed: number;
  readonly unrecognizedKeys: number;
  readonly objectsChanged: number;
  readonly rowsIn: number;
  readonly rowsOut: number;
  readonly unrecognizedKeyExamples: readonly string[];
  readonly failureGroups: readonly {
    readonly group: string;
    readonly count: number;
    readonly examples: FailureGroup["examples"];
  }[];
}

export function summarizeDryRun(
  tally: DryRunTally,
  timing: { readonly startedAt: string; readonly finishedAt: string },
): DryRunSummary {
  return {
    ...timing,
    prefix: CHAT_EVENT_SNAPSHOT_PREFIX,
    sourceVersion: PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION,
    objectsListed: tally.objectsListed,
    objectsChecked: tally.objectsChecked,
    succeeded: tally.succeeded,
    failed: tally.failed,
    downloadFailed: tally.downloadFailed,
    unrecognizedKeys: tally.unrecognizedKeys,
    objectsChanged: tally.objectsChanged,
    rowsIn: tally.rowsIn,
    rowsOut: tally.rowsOut,
    unrecognizedKeyExamples: tally.unrecognizedKeyExamples,
    failureGroups: [...tally.failureGroups.entries()]
      .map(([group, value]) => {
        return { group, count: value.count, examples: value.examples };
      })
      .sort((left, right) => {
        return right.count - left.count;
      }),
  };
}

function markdownCell(value: string): string {
  return value.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
}

export function renderDryRunMarkdown(summary: DryRunSummary): string {
  const verdict =
    summary.failed === 0 && summary.downloadFailed === 0
      ? "PASS: every checked object upgraded to V8."
      : "FAIL: some objects did not upgrade or could not be read.";
  const lines = [
    "## Chat Event V7 -> V8 Snapshot dry run",
    "",
    verdict,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Prefix | \`${summary.prefix}\` |`,
    `| Source version | ${summary.sourceVersion.toString()} |`,
    `| Started | ${summary.startedAt} |`,
    `| Finished | ${summary.finishedAt} |`,
    `| Objects listed | ${summary.objectsListed.toString()} |`,
    `| Objects checked | ${summary.objectsChecked.toString()} |`,
    `| Succeeded | ${summary.succeeded.toString()} |`,
    `| Failed | ${summary.failed.toString()} |`,
    `| Download failed after retries | ${summary.downloadFailed.toString()} |`,
    `| Unrecognized keys (skipped) | ${summary.unrecognizedKeys.toString()} |`,
    `| Objects changed by the upgrade | ${summary.objectsChanged.toString()} |`,
    `| Rows in / rows out | ${summary.rowsIn.toString()} / ${summary.rowsOut.toString()} |`,
  ];
  if (summary.failureGroups.length > 0) {
    lines.push("", "### Failure groups", "");
    for (const group of summary.failureGroups) {
      lines.push(
        `#### \`${markdownCell(group.group)}\`: ${group.count.toString()}`,
        "",
        "| Thread | Key | Path | Reason |",
        "| --- | --- | --- | --- |",
        ...group.examples.map((example) => {
          return `| ${example.threadId} | \`${markdownCell(example.key)}\` | \`${markdownCell(example.path)}\` | ${markdownCell(example.reason)} |`;
        }),
        "",
      );
    }
  }
  if (summary.unrecognizedKeyExamples.length > 0) {
    lines.push(
      "",
      "### Unrecognized keys (first 20)",
      "",
      ...summary.unrecognizedKeyExamples.map((key) => {
        return `- \`${markdownCell(key)}\``;
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

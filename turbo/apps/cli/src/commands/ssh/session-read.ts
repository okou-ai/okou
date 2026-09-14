import { Command } from "commander";
import { z } from "zod";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { writeOutput } from "./rpc";
import {
  sessionRpc,
  type SessionReadFailure,
  type SessionReadPage,
} from "./session-rpc";

const COLLECTION_MS = 35_000;
const MAX_CHUNKS = 256;
const MAX_REQUESTS = 64;
type StopReason =
  | "caught_up"
  | "wait_elapsed"
  | "byte_limit"
  | "chunk_limit"
  | "request_limit"
  | "time_limit"
  | "terminal"
  | "failed";

interface ReadResult {
  type: "read";
  session_id: string;
  session: SessionReadPage["session"] | null;
  chunks: SessionReadPage["chunks"];
  lost: NonNullable<SessionReadPage["lost"]>[];
  next_cursor: number;
  more_available: boolean | null;
  stop_reason: StopReason;
  failure: SessionReadFailure | null;
  next_command: string | null;
  limits: {
    wait_seconds: number;
    max_bytes: number;
    max_chunks: number;
    max_requests: number;
    collection_seconds: number;
  };
}

interface ReadOptions {
  cursor: string;
  wait: string;
  maxBytes: string;
  json?: boolean;
}

function integer(value: string, name: string, min: number, max: number) {
  const parsed = Number(value);
  if (
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}

function readerFailure(signal: AbortSignal): SessionReadFailure {
  return {
    type: "failed",
    failure_reason:
      signal.reason instanceof DOMException &&
      signal.reason.name === "TimeoutError"
        ? "timed_out"
        : "cancelled",
    effects: "not_started",
  };
}

async function collect(result: ReadResult, signal: AbortSignal) {
  let bytes = 0;
  for (let request = 0; request < MAX_REQUESTS; request++) {
    if (signal.aborted) {
      result.failure = readerFailure(signal);
      break;
    }
    const page = await sessionRpc(
      "read",
      {
        sessionId: result.session_id,
        cursor: result.next_cursor,
        waitMs:
          request === 0 ? Math.round(result.limits.wait_seconds * 1000) : 0,
        maxBytes: Math.min(8192, result.limits.max_bytes - bytes),
        maxChunks: Math.min(32, MAX_CHUNKS - result.chunks.length),
      },
      signal,
    );
    if (page.type === "failed" || page.type === "rpc_error") {
      result.failure = page;
      break;
    }
    if (page.type !== "read") throw new Error("Unexpected SSH read result");
    // Only EOF/exit-verified pages advance the non-consuming continuation.
    result.session = page.session;
    result.chunks.push(...page.chunks);
    if (page.lost) result.lost.push(page.lost);
    for (const chunk of page.chunks)
      bytes += Buffer.from(chunk.data, "base64").length;
    result.next_cursor = page.next_cursor;
    result.more_available = page.next_cursor < page.session.end_cursor;
    if (!result.more_available) {
      result.stop_reason = ["finished", "failed"].includes(
        page.session.state.type,
      )
        ? "terminal"
        : page.wait_expired
          ? "wait_elapsed"
          : "caught_up";
      return;
    }
    if (bytes === result.limits.max_bytes) {
      result.stop_reason = "byte_limit";
      return;
    }
    if (result.chunks.length === MAX_CHUNKS) {
      result.stop_reason = "chunk_limit";
      return;
    }
    result.stop_reason = "request_limit";
  }
  if (result.failure)
    result.stop_reason =
      result.failure.type === "failed" &&
      result.failure.failure_reason === "timed_out"
        ? "time_limit"
        : "failed";
}

function textOrBinary(bytes: Buffer, stream: string, cursor: number) {
  let text: string | undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    // Invalid UTF-8 is represented losslessly below, not replaced with U+FFFD.
  }
  // Do not execute terminal-control sequences or silently replace binary data.
  if (
    text !== undefined &&
    ![...text].some((char) => {
      const code = char.codePointAt(0);
      return (
        code !== undefined &&
        ((code < 32 && code !== 9 && code !== 10) ||
          (code >= 127 && code <= 159))
      );
    })
  )
    return bytes;
  return Buffer.from(
    `[${stream} binary bytes ${cursor}–${cursor + bytes.length}: base64 ${bytes.toString("base64")}]\n`,
  );
}

async function print(result: ReadResult, json: boolean, signal: AbortSignal) {
  if (json) {
    await writeOutput(
      process.stdout,
      Buffer.from(`${JSON.stringify(result)}\n`),
      signal,
    );
    return;
  }
  for (let index = 0; index < result.chunks.length; ) {
    const first = result.chunks[index];
    if (!first) throw new Error("Missing SSH output chunk");
    const firstBytes = Buffer.from(first.data, "base64");
    const chunks = [firstBytes];
    let end = first.cursor + firstBytes.length;
    index++;
    while (index < result.chunks.length) {
      const next = result.chunks[index];
      if (!next || next.stream !== first.stream || next.cursor !== end) break;
      const bytes = Buffer.from(next.data, "base64");
      chunks.push(bytes);
      end += bytes.length;
      index++;
    }
    await writeOutput(
      first.stream === "stdout" ? process.stdout : process.stderr,
      textOrBinary(Buffer.concat(chunks), first.stream, first.cursor),
      signal,
    );
  }
  const metadata = [
    `\nSSH read: ${result.stop_reason}; observed state=${result.session?.state.type ?? "unknown"}; next_cursor=${result.next_cursor}; more_available=${result.more_available ?? "unknown"}.`,
    ...result.lost.map((lost) => {
      return `Output bytes ${lost.from}–${lost.to} were discarded from the bounded buffer.`;
    }),
  ];
  if (result.session?.state.type === "finished")
    metadata.push(`Remote exit: ${JSON.stringify(result.session.state.exit)}.`);
  if (result.session?.state.type === "failed")
    metadata.push(
      `Remote failure: ${result.session.state.failure_reason}; effects=${result.session.effects}.`,
    );
  if (result.failure)
    metadata.push(
      `Reader failure: ${JSON.stringify(result.failure)}. Prior output/state are only the last verified observation; this read did not stop or replay the remote process.`,
    );
  if (result.next_command) metadata.push(`Continue: ${result.next_command}`);
  await writeOutput(
    process.stderr,
    Buffer.from(`${metadata.join("\n")}\n`),
    signal,
  );
}

export function createSessionReadCommand(requireCapability: () => void) {
  return new Command("read")
    .description(
      "Read the next bounded batch of SSH output; wait for progress, not process completion",
    )
    .argument("<session-id>", "Exact ID from ssh session start or list")
    .option(
      "--cursor <offset>",
      "Nonnegative byte cursor from the previous read",
      "0",
    )
    .option(
      "--wait <seconds>",
      "Wait for new output up to 30 seconds; 0 reads immediately",
      "10",
    )
    .option("--max-bytes <bytes>", "Output budget, 1–65536 bytes", "16384")
    .option(
      "--json",
      "Print exact base64 chunks, observed state, stop reason, lost ranges and continuation",
    )
    .addHelpText(
      "after",
      "\nLimits: 35 seconds collecting, 256 chunks, 64 page requests, then up to 5 seconds reporting. Cancellation/time-limit reporting gets 1 second. Only 2 reads per Run may wait for future output. Wait expiry is not remote failure. Reading/cancellation never closes the session. A disconnected reader may hold its Runner request/park reservation until its wait ends (up to 30 seconds plus terminal reserve). Exit 0 means the read succeeded, not that the remote process succeeded.\n",
    )
    .action(
      withErrorHandler(async (sessionId: string, options: ReadOptions) => {
        requireCapability();
        if (!z.uuid().safeParse(sessionId).success)
          throw new Error("Use an exact ID from ssh session start or list.");
        const cursor = integer(
          options.cursor,
          "Cursor",
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const maxBytes = integer(options.maxBytes, "--max-bytes", 1, 65536);
        const wait = Number(options.wait);
        if (
          !/^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/.test(options.wait) ||
          !Number.isFinite(wait) ||
          wait > 30
        )
          throw new Error(
            "--wait must be 0–30 seconds with at most 3 decimal places.",
          );
        const result: ReadResult = {
          type: "read",
          session_id: sessionId.toLowerCase(),
          session: null,
          chunks: [],
          lost: [],
          next_cursor: cursor,
          more_available: null,
          stop_reason: "caught_up",
          failure: null,
          next_command: null,
          limits: {
            wait_seconds: wait,
            max_bytes: maxBytes,
            max_chunks: MAX_CHUNKS,
            max_requests: MAX_REQUESTS,
            collection_seconds: COLLECTION_MS / 1000,
          },
        };
        const cancel = new AbortController();
        const onInterrupt = () => {
          return cancel.abort();
        };
        process.once("SIGINT", onInterrupt);
        const collection = AbortSignal.any([
          cancel.signal,
          AbortSignal.timeout(COLLECTION_MS),
        ]);
        try {
          await collect(result, collection);
          const unavailable =
            result.failure?.type === "failed" &&
            ["unavailable", "configuration_changed"].includes(
              result.failure.failure_reason,
            );
          if (unavailable) result.next_command = "okou ssh session list";
          else if (
            result.stop_reason !== "terminal" &&
            result.failure?.type !== "rpc_error"
          )
            result.next_command = `okou ssh session read ${result.session_id} --cursor ${result.next_cursor} --wait ${wait} --max-bytes ${maxBytes}${options.json ? " --json" : ""}`;
          process.exitCode = result.failure ? 1 : 0;
          const reporting = collection.aborted
            ? AbortSignal.timeout(1000)
            : AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)]);
          await print(result, options.json === true, reporting);
        } finally {
          process.removeListener("SIGINT", onInterrupt);
        }
      }),
    );
}

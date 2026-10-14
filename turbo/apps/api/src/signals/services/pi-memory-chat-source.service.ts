import { createHash } from "node:crypto";
import { projectPiMemoryChatStage1Evidence } from "@okouai/pi-agent-runtime/api";
import { piMemoryChatInputSchema } from "@okouai/api-contracts/contracts/pi-memory-chat-source";
import { blobs } from "@okouai/db/schema/blob";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { putImmutableS3Object } from "../external/s3";
import { readMemoryChatEventRows$ } from "./chat-event-row-read.service";
import { resumeSessionHistoryRawBlobKey } from "./session-history-blobs";

/** Candidate-owned settled Chat input; no Thread or native-history archive. */
export const preparePiMemoryChatSource$ = command(
  async (
    { get, set },
    args: {
      readonly runId: string;
      readonly threadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly lastSeqId: number;
    },
    signal: AbortSignal,
  ) => {
    const events = await set(readMemoryChatEventRows$, args, signal);
    const input = piMemoryChatInputSchema.parse({
      schemaVersion: 1,
      threadId: args.threadId,
      sourceRunId: args.runId,
      lastSeqId: args.lastSeqId,
      events,
    });
    projectPiMemoryChatStage1Evidence({
      input,
      threadId: args.threadId,
      sourceRunId: args.runId,
      lastSeqId: args.lastSeqId,
    });
    const bytes = Buffer.from(JSON.stringify(input));
    if (bytes.length > 8 * 1024 * 1024) {
      throw new Error("Memory Chat input exceeds its byte budget");
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    await get(
      putImmutableS3Object(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        resumeSessionHistoryRawBlobKey(hash),
        bytes,
        "application/json",
        signal,
      ),
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db
      .insert(blobs)
      .values({
        hash,
        rawSize: bytes.length,
        encodedSize: bytes.length,
        encoding: "identity",
        refCount: 0,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    const [stored] = await db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(
        and(
          eq(blobs.hash, hash),
          eq(blobs.rawSize, bytes.length),
          eq(blobs.encodedSize, bytes.length),
          eq(blobs.encoding, "identity"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!stored) {
      throw new Error("Memory Chat input blob identity mismatch");
    }
    return {
      piSessionId: args.threadId,
      hash,
      sourceFormat: "chat-events-v1" as const,
      sourceChatEventSeqId: args.lastSeqId,
    };
  },
);

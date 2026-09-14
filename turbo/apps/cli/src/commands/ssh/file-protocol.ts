import { z } from "zod";
import { failureReasonSchema, rpcErrorSchema } from "./rpc";

export const FILE_LIMITS = {
  max_file_bytes: 1_073_741_824,
  timeout_ms: 900_000,
  max_concurrent_transfers: 2,
} as const;
export const FILE_LIMIT_HELP =
  "Limits: 1 GiB (1,073,741,824 bytes) per file; 15 minutes total per helper invocation, including setup and I/O waits; 2 simultaneous transfers per Run, shared by uploads and downloads. No option overrides these limits.";
export type Direction = "upload" | "download";
const fileReasonSchema = z.enum([
  "file_too_large",
  "transfer_limit",
  "path_not_found",
  "permission_denied",
  "destination_exists",
  "not_regular_file",
  "source_changed",
  "subsystem_unavailable",
  "unsupported_operation",
  "file_operation_failed",
  "local_io",
  "invalid_path",
  "helper_unavailable",
]);
const reasonSchema = z.union([failureReasonSchema, fileReasonSchema]);
export type FileReason = z.infer<typeof reasonSchema>;
export const outcomeSchema = z
  .object({
    type: z.enum(["completed", "failed"]),
    direction: z.enum(["upload", "download"]),
    ssh_connection_id: z.uuid(),
    bytes: z.number().int().min(0).max(FILE_LIMITS.max_file_bytes),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    effects: z.enum(["not_started", "unknown", "completed"]),
    failure_reason: reasonSchema.nullable(),
    residue: z.string().max(4096).nullable(),
    actual_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    limits: z
      .object({
        max_file_bytes: z.literal(FILE_LIMITS.max_file_bytes),
        timeout_ms: z.literal(FILE_LIMITS.timeout_ms),
        max_concurrent_transfers: z.literal(
          FILE_LIMITS.max_concurrent_transfers,
        ),
      })
      .strict(),
  })
  .strict()
  .refine((value) => {
    return value.type === "completed"
      ? value.sha256 !== null &&
          value.failure_reason === null &&
          value.actual_bytes === value.bytes &&
          value.effects ===
            (value.direction === "upload" ? "completed" : "not_started")
      : value.failure_reason !== null && value.effects !== "completed";
  });
export type FileOutcome = z.infer<typeof outcomeSchema>;
const envelopeSchema = z.union([
  z.object({ type: z.literal("result"), data: outcomeSchema }).strict(),
  rpcErrorSchema,
]);
export type FileTerminal = z.infer<typeof envelopeSchema>;

export class FileError extends Error {
  constructor(readonly reason: FileReason) {
    super(reason);
  }
}

export function failure(
  direction: Direction,
  id: string,
  reason: FileReason,
): FileOutcome {
  return {
    type: "failed",
    direction,
    ssh_connection_id: id,
    bytes: 0,
    sha256: null,
    effects: "not_started",
    failure_reason: reason,
    residue: null,
    actual_bytes: null,
    limits: FILE_LIMITS,
  };
}

export function frame(bytes: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

/** One bounded allocation per validated length; no concatenation of arbitrary
 * stdout chunks, no whole-file buffering, no terminal accepted without EOF. */
export class FileFrames {
  private header = Buffer.alloc(4);
  private headerSize = 0;
  private payload: Buffer | undefined;
  private payloadSize = 0;
  private frames = 0;
  bytes = 0;
  ended = false;
  terminal: FileTerminal | undefined;

  async read(value: unknown, data: (bytes: Buffer) => Promise<void>) {
    if (!Buffer.isBuffer(value)) throw new FileError("protocol");
    let chunk = value;
    while (chunk.length) {
      if (this.terminal) throw new FileError("protocol");
      if (!this.payload) {
        const size = Math.min(4 - this.headerSize, chunk.length);
        chunk.copy(this.header, this.headerSize, 0, size);
        this.headerSize += size;
        chunk = chunk.subarray(size);
        if (this.headerSize < 4) continue;
        const length = this.header.readUInt32BE();
        if (length === 0 || length > 65537) throw new FileError("protocol");
        this.payload = Buffer.alloc(length);
        this.payloadSize = 0;
      }
      const size = Math.min(
        this.payload.length - this.payloadSize,
        chunk.length,
      );
      chunk.copy(this.payload, this.payloadSize, 0, size);
      this.payloadSize += size;
      chunk = chunk.subarray(size);
      if (this.payloadSize === this.payload.length) {
        await this.message(this.payload, data);
        this.headerSize = 0;
        this.payload = undefined;
      }
    }
  }

  private async message(
    payload: Buffer,
    data: (bytes: Buffer) => Promise<void>,
  ) {
    if (payload[0] === 0 || payload[0] === 1) {
      const end = payload[0] === 1;
      if (
        this.ended ||
        ++this.frames > (end ? 65536 : 65535) ||
        (end ? payload.length !== 1 : payload.length === 1)
      )
        throw new FileError("protocol");
      if (end) this.ended = true;
      else {
        this.bytes += payload.length - 1;
        if (this.bytes > FILE_LIMITS.max_file_bytes)
          throw new FileError("protocol");
        await data(payload.subarray(1));
      }
      return;
    }
    if (payload.length > 24576) throw new FileError("protocol");
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(payload),
      );
    } catch {
      throw new FileError("protocol");
    }
    const parsed = envelopeSchema.safeParse(decoded);
    if (!parsed.success) throw new FileError("protocol");
    if (
      (parsed.data.type === "result" && this.bytes > 0 && !this.ended) ||
      (parsed.data.type === "error" &&
        parsed.data.delivery === "not_dispatched" &&
        this.frames > 0)
    )
      throw new FileError("protocol");
    this.terminal = parsed.data;
  }

  finish(): FileTerminal {
    if (this.headerSize || this.payload || !this.terminal)
      throw new FileError("protocol");
    return this.terminal;
  }
}

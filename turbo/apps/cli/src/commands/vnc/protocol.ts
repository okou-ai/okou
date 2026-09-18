import { z } from "zod";

export const VNC_LIMITS = {
  imageBytes: 16 * 1024 * 1024,
  frameBytes: 65537,
  controlBytes: 24576,
  frames: 512,
  timeoutMs: 65000,
} as const;

export type VncMethod =
  | "vnc.session.start"
  | "vnc.session.list"
  | "vnc.session.status"
  | "vnc.session.close"
  | "vnc.capture"
  | "vnc.input";

const reasonSchema = z.enum([
  "unavailable",
  "authority_failure",
  "configuration_changed",
  "unsupported_profile",
  "invalid_credential",
  "unsafe_destination",
  "network_failure",
  "protocol",
  "timed_out",
  "cancelled",
  "resource_exhausted",
  "session_not_found",
  "invalid_input",
  "stale_geometry",
  "disconnected",
  "authentication_failed",
]);
export type VncReason =
  | z.infer<typeof reasonSchema>
  | "permission_denied"
  | "unsupported_runner"
  | "helper_unavailable"
  | "transport"
  | "path_not_found"
  | "destination_exists"
  | "not_regular_file"
  | "local_io"
  | "invalid_path";
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sessionSchema = z.strictObject({
  sessionId: z.uuid(),
  connectionId: z.uuid(),
  mode: z.enum(["shared", "exclusive"]),
});
const captureSchema = z.strictObject({
  kind: z.literal("capture"),
  mimeType: z.literal("image/png"),
  bytes: integer.min(1).max(VNC_LIMITS.imageBytes),
  width: integer.min(1).max(65535),
  height: integer.min(1).max(65535),
  geometry: z.strictObject({ sessionId: z.uuid(), epoch: integer }),
  updateSequence: integer,
  capturedAt: integer,
});
const resultSchema = z.union([
  z.strictObject({ outcome: z.literal("started"), session: sessionSchema }),
  z.strictObject({
    outcome: z.literal("listed"),
    sessions: z.array(sessionSchema).max(2),
  }),
  z.strictObject({ outcome: z.literal("status"), session: sessionSchema }),
  z.strictObject({ outcome: z.literal("closed") }),
  z.strictObject({ outcome: z.literal("captured"), bytes: integer.min(1) }),
  z.strictObject({ outcome: z.literal("sent") }),
  z.strictObject({
    outcome: z.enum(["not_started", "unknown", "failed"]),
    reason: reasonSchema,
  }),
]);
const envelopeSchema = z.union([
  z.strictObject({ type: z.literal("event"), data: captureSchema }),
  z.strictObject({ type: z.literal("result"), data: resultSchema }),
  z.strictObject({
    type: z.literal("error"),
    code: z.enum([
      "invalid_request",
      "unknown_method",
      "unavailable",
      "protocol",
      "transport",
      "timed_out",
      "resource_exhausted",
    ]),
    delivery: z.enum(["not_dispatched", "unknown"]),
  }),
]);
type CaptureMetadata = z.infer<typeof captureSchema>;
type Result = z.infer<typeof resultSchema>;
const methodOutcomes: Record<VncMethod, readonly Result["outcome"][]> = {
  "vnc.session.start": ["started"],
  "vnc.session.list": ["listed"],
  "vnc.session.status": ["status"],
  "vnc.session.close": ["closed"],
  "vnc.capture": ["captured"],
  "vnc.input": ["sent", "not_started", "unknown"],
};
export type VncTerminal = Exclude<
  z.infer<typeof envelopeSchema>,
  { type: "event" }
>;
export type VncOutcome = (
  | Exclude<Result, { outcome: "captured" }>
  | (CaptureMetadata & {
      outcome: "captured";
      path: string;
      sha256: string;
    })
  | {
      outcome: "failed" | "not_started" | "unknown";
      reason: VncReason;
      delivery: "not_dispatched" | "unknown";
    }
) & { cleanupReason?: "local_io"; residue?: string | null };

export class VncError extends Error {
  constructor(readonly reason: VncReason) {
    super(reason);
  }
}

export function frame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

/** Allocations follow validated frame lengths; stdout is never concatenated. */
export class VncFrames {
  private readonly header = Buffer.alloc(4);
  private headerSize = 0;
  private payload: Buffer | undefined;
  private payloadSize = 0;
  private count = 0;
  bytes = 0;
  ended = false;
  metadata: CaptureMetadata | undefined;
  terminal: VncTerminal | undefined;

  constructor(
    private readonly method: VncMethod,
    private readonly params: Record<string, unknown>,
  ) {}

  async read(value: unknown, write: (bytes: Buffer) => Promise<void>) {
    if (!Buffer.isBuffer(value)) throw new VncError("protocol");
    let chunk = value;
    while (chunk.length) {
      if (this.terminal) throw new VncError("protocol");
      if (!this.payload) {
        const size = Math.min(4 - this.headerSize, chunk.length);
        chunk.copy(this.header, this.headerSize, 0, size);
        this.headerSize += size;
        chunk = chunk.subarray(size);
        if (this.headerSize < 4) continue;
        const length = this.header.readUInt32BE();
        if (!length || length > VNC_LIMITS.frameBytes)
          throw new VncError("protocol");
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
        await this.message(this.payload, write);
        this.headerSize = 0;
        this.payload = undefined;
      }
    }
  }

  private async message(
    payload: Buffer,
    write: (bytes: Buffer) => Promise<void>,
  ) {
    if (++this.count > VNC_LIMITS.frames) throw new VncError("protocol");
    if (payload[0] === 0 || payload[0] === 1) {
      if (!this.metadata || this.ended) throw new VncError("protocol");
      if (payload[0] === 1) {
        if (payload.length !== 1 || this.bytes !== this.metadata.bytes)
          throw new VncError("protocol");
        this.ended = true;
      } else {
        if (payload.length === 1) throw new VncError("protocol");
        this.bytes += payload.length - 1;
        if (this.bytes > this.metadata.bytes) throw new VncError("protocol");
        await write(payload.subarray(1));
      }
      return;
    }
    if (payload.length > VNC_LIMITS.controlBytes)
      throw new VncError("protocol");
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(payload),
      );
    } catch {
      throw new VncError("protocol");
    }
    const parsed = envelopeSchema.safeParse(decoded);
    if (!parsed.success) throw new VncError("protocol");
    const message = parsed.data;
    if (message.type === "event") {
      if (this.method !== "vnc.capture" || this.metadata)
        throw new VncError("protocol");
      this.metadata = message.data;
    } else {
      if (message.type === "error") {
        if (this.metadata && message.delivery === "not_dispatched")
          throw new VncError("protocol");
      } else this.validateResult(message.data);
      this.terminal = message;
    }
  }

  private validateResult(result: Result) {
    if (result.outcome === "failed") {
      if (this.method === "vnc.input" || this.metadata)
        throw new VncError("protocol");
      return;
    }
    if (!methodOutcomes[this.method].includes(result.outcome))
      throw new VncError("protocol");
    switch (result.outcome) {
      case "started":
        if (
          result.session.connectionId === this.params.connectionId &&
          result.session.mode === this.params.mode
        )
          return;
        break;
      case "listed":
        if (
          new Set(
            result.sessions.map((session) => {
              return session.sessionId;
            }),
          ).size === result.sessions.length
        )
          return;
        break;
      case "status":
        if (result.session.sessionId === this.params.sessionId) return;
        break;
      case "captured":
        if (this.ended && result.bytes === this.bytes) return;
        break;
      default:
        return;
    }
    throw new VncError("protocol");
  }

  finish(): VncTerminal {
    if (this.headerSize || this.payload || !this.terminal)
      throw new VncError("protocol");
    return this.terminal;
  }
}

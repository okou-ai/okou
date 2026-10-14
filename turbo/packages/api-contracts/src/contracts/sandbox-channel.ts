import { z } from "zod";

const schemaVersion = 1;
/** One current envelope; category revisions evolve independently. */
export const SANDBOX_CHANNEL_LIMITS = {
  schemaVersion,
  // Both canonical UUIDs are exactly 36 unescaped ASCII bytes. No ID is emitted here.
  responseOverheadBytes:
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion,
        type: "response",
        id: "0".repeat(36),
        requestId: "0".repeat(36),
        result: null,
      }),
    ).byteLength - 4,
  maxFrameBytes: 64 * 1024,
  maxQueuedBytes: 256 * 1024,
  maxQueuedFrames: 8,
  maxPending: 8,
  maxIncoming: 8,
  helloTimeoutMs: 5000,
  requestTimeoutMs: 10_000,
  writeTimeoutMs: 15_000,
  maxCategories: 32,
  maxCategoryNameBytes: 32,
  maxCategoryVersion: 2_147_483_647,
  maxJsonDepth: 64,
} as const;

export const sandboxChannelIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const sandboxChannelCategoryNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const sandboxChannelVersionSchema = z
  .int()
  .min(1)
  .max(SANDBOX_CHANNEL_LIMITS.maxCategoryVersion);
export const sandboxChannelNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,63}$/);
export const sandboxChannelCategoriesSchema = z
  .record(sandboxChannelCategoryNameSchema, sandboxChannelVersionSchema)
  .refine((value) => {
    return Object.keys(value).length <= SANDBOX_CHANNEL_LIMITS.maxCategories;
  });

export const sandboxChannelErrorSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  category: sandboxChannelCategoryNameSchema.optional(),
  expectedVersion: sandboxChannelVersionSchema.optional(),
  receivedVersion: sandboxChannelVersionSchema.optional(),
});

const header = {
  schemaVersion: z.literal(SANDBOX_CHANNEL_LIMITS.schemaVersion),
  id: sandboxChannelIdSchema,
};
export const sandboxChannelObjectSchema = z.record(z.string(), z.unknown());
export const sandboxChannelHelloSchema = z.strictObject({
  ...header,
  type: z.literal("hello"),
  categories: sandboxChannelCategoriesSchema,
});
export const sandboxChannelHelloResultSchema = z.strictObject({
  categories: sandboxChannelCategoriesSchema,
});

/** Opaque fields are interpreted only by the captured category contract. */
export const sandboxChannelWireSchema = z.discriminatedUnion("type", [
  sandboxChannelHelloSchema,
  z.strictObject({
    ...header,
    type: z.literal("request"),
    category: sandboxChannelCategoryNameSchema,
    categoryVersion: sandboxChannelVersionSchema,
    operation: sandboxChannelNameSchema,
    params: sandboxChannelObjectSchema,
  }),
  z.strictObject({
    ...header,
    type: z.literal("response"),
    requestId: sandboxChannelIdSchema,
    result: z.unknown().optional(),
    error: sandboxChannelErrorSchema.optional(),
  }),
  z.strictObject({
    ...header,
    type: z.literal("event"),
    category: sandboxChannelCategoryNameSchema,
    categoryVersion: sandboxChannelVersionSchema,
    event: sandboxChannelNameSchema,
    data: sandboxChannelObjectSchema,
  }),
]);

export type SandboxChannelMessage = z.infer<typeof sandboxChannelWireSchema>;
export type SandboxChannelWireError = z.infer<typeof sandboxChannelErrorSchema>;
export type SandboxChannelRole = "external" | "guest";
export type SandboxChannelOrigin = SandboxChannelRole | "either";

export const SANDBOX_CHANNEL_ERROR_CODES = [
  "unsupported_schema",
  "unsupported_category",
  "category_version_mismatch",
  "unknown_operation",
  "invalid_request",
  "invalid_params",
  "outside_home",
  "not_found",
  "not_directory",
  "link_not_expandable",
  "mount_not_expandable",
  "directory_changed",
  "cursor_expired",
  "limit_exceeded",
  "busy",
  "forbidden",
  "unavailable",
] as const;
export type SandboxChannelErrorCode =
  (typeof SANDBOX_CHANNEL_ERROR_CODES)[number];

/** Safe local error: no remote path, exception or payload becomes its message. */
export class SandboxChannelError extends Error {
  constructor(
    readonly code: SandboxChannelErrorCode,
    readonly details?: Omit<SandboxChannelWireError, "code">,
  ) {
    super(`Sandbox channel: ${code}`);
    this.name = "SandboxChannelError";
  }

  toWire(): SandboxChannelWireError {
    return sandboxChannelErrorSchema.parse({
      code: this.code,
      ...this.details,
    });
  }
}

export function sandboxChannelRemoteError(
  error: SandboxChannelWireError,
): SandboxChannelError {
  const code = SANDBOX_CHANNEL_ERROR_CODES.find((known) => {
    return known === error.code;
  });
  return new SandboxChannelError(code ?? "unavailable", {
    ...(error.category !== undefined ? { category: error.category } : {}),
    ...(error.expectedVersion !== undefined
      ? { expectedVersion: error.expectedVersion }
      : {}),
    ...(error.receivedVersion !== undefined
      ? { receivedVersion: error.receivedVersion }
      : {}),
  });
}

/** Minimal header inspection precedes current-schema parsing. */
export function decodeSandboxChannelFrame(
  frame: ArrayBuffer | Uint8Array,
): SandboxChannelMessage {
  if (frame.byteLength > SANDBOX_CHANNEL_LIMITS.maxFrameBytes) {
    throw new SandboxChannelError("limit_exceeded");
  }
  let value: unknown;
  try {
    // Preserve a BOM so JSON rejects it, matching the native decoder.
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(frame),
    );
  } catch {
    throw new SandboxChannelError("invalid_request");
  }
  validateSandboxChannelJson(value);
  const headerResult = z
    .object({ schemaVersion: sandboxChannelVersionSchema })
    .safeParse(value);
  if (!headerResult.success) {
    throw new SandboxChannelError("invalid_request");
  }
  if (
    headerResult.data.schemaVersion !== SANDBOX_CHANNEL_LIMITS.schemaVersion
  ) {
    throw new SandboxChannelError("unsupported_schema");
  }
  const parsed = sandboxChannelWireSchema.safeParse(value);
  if (!parsed.success) {
    throw new SandboxChannelError("invalid_request");
  }
  const message = parsed.data;
  if (
    message.type === "response" &&
    Object.hasOwn(message, "result") === Object.hasOwn(message, "error")
  ) {
    throw new SandboxChannelError("invalid_request");
  }
  return message;
}

export function encodeSandboxChannelFrame(
  message: SandboxChannelMessage,
): ArrayBuffer {
  validateSandboxChannelJson(message);
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  // Validate the actual encoded shape, including omitted undefined fields.
  decodeSandboxChannelFrame(bytes);
  return bytes.buffer;
}

/** Interoperable JSON: finite numbers, Unicode scalar strings and finite depth. */
function validateSandboxChannelJson(value: unknown): void {
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (item.depth > SANDBOX_CHANNEL_LIMITS.maxJsonDepth)
      throw new SandboxChannelError("limit_exceeded");
    if (typeof item.value === "string") {
      if (item.value.length > SANDBOX_CHANNEL_LIMITS.maxFrameBytes)
        throw new SandboxChannelError("limit_exceeded");
      if (/[\uD800-\uDFFF]/u.test(item.value))
        throw new SandboxChannelError("invalid_request");
    } else if (typeof item.value === "number") {
      if (!Number.isFinite(item.value))
        throw new SandboxChannelError("invalid_request");
    } else if (item.value !== null && typeof item.value === "object") {
      const proto: unknown = Object.getPrototypeOf(item.value);
      if (
        !Array.isArray(item.value) &&
        proto !== Object.prototype &&
        proto !== null
      )
        throw new SandboxChannelError("invalid_request");
      for (const [name, child] of Object.entries(item.value)) {
        // Reject the setter-shaped key that record parsers would otherwise discard.
        if (name === "__proto__")
          throw new SandboxChannelError("invalid_request");
        if (/[\uD800-\uDFFF]/u.test(name))
          throw new SandboxChannelError("invalid_request");
        stack.push({ value: child, depth: item.depth + 1 });
      }
    } else if (item.value !== null && typeof item.value !== "boolean") {
      throw new SandboxChannelError("invalid_request");
    }
  }
}

export interface SandboxChannelPayloadSchema<T = unknown> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
}

export interface SandboxChannelOperation<P = unknown, R = unknown> {
  readonly category: string;
  readonly categoryVersion: number;
  readonly operation: string;
  readonly origin: SandboxChannelOrigin;
  readonly params: SandboxChannelPayloadSchema<P>;
  readonly result: SandboxChannelPayloadSchema<R>;
}

export interface SandboxChannelEvent<D = unknown> {
  readonly category: string;
  readonly categoryVersion: number;
  readonly event: string;
  readonly origin: SandboxChannelOrigin;
  readonly data: SandboxChannelPayloadSchema<D>;
}

export interface SandboxChannelCategoryContract {
  readonly category: string;
  readonly version: number;
  readonly operations: readonly SandboxChannelOperation[];
  readonly events: readonly SandboxChannelEvent[];
}

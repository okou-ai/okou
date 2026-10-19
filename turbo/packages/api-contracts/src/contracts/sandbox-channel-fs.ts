import { z } from "zod";
import { SANDBOX_CHANNEL_LIMITS } from "./sandbox-channel";
import type {
  SandboxChannelCategoryContract,
  SandboxChannelOperation,
} from "./sandbox-channel";

export const SANDBOX_FS_VERSION = 3;
export const SANDBOX_FS_LIMITS = {
  maxEntries: 128,
  maxResponseBytes: 48 * 1024,
  maxPathComponents: 64,
  maxPathBytes: 4096,
  maxNameBytes: 255,
  maxDisplayNameBytes: 4096,
  maxCursors: 8,
  cursorIdleMs: 30_000,
  maxEnumerationSteps: 512,
  processingBudgetMs: 2000,
  maxChunkBytes: 32 * 1024,
  maxHandles: 4,
  maxInFlightReads: 4,
  handleIdleMs: 30_000,
  maxPreviewBytes: 16 * 1024 * 1024,
  maxPrefixBytes: 64 * 1024,
} as const;

/** Canonical raw basename bytes; display labels never become path inputs. */
export function sandboxNameBytes(token: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{1,340}$/.test(token)) return null;
  try {
    const raw = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
    if (
      raw.length > SANDBOX_FS_LIMITS.maxNameBytes ||
      raw === "." ||
      raw === ".." ||
      raw.includes("/") ||
      raw.includes("\0")
    )
      return null;
    if (
      btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !==
      token
    )
      return null;
    return Uint8Array.from(raw, (char) => {
      return char.charCodeAt(0);
    });
  } catch {
    return null;
  }
}

export const sandboxNameTokenSchema = z.string().refine((token) => {
  return sandboxNameBytes(token) !== null;
});
const pathSchema = z
  .array(sandboxNameTokenSchema)
  .max(SANDBOX_FS_LIMITS.maxPathComponents)
  .refine((path) => {
    return (
      path.reduce(
        (sum, token) => {
          return (
            sum +
            (sandboxNameBytes(token)?.length ??
              SANDBOX_FS_LIMITS.maxPathBytes + 1)
          );
        },
        Math.max(path.length - 1, 0),
      ) <= SANDBOX_FS_LIMITS.maxPathBytes
    );
  });
const handleSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** fs v3 paths are raw basename tokens relative to Guest /; [] denotes /. */
export const sandboxFsListParamsSchema = z
  .strictObject({
    path: pathSchema.optional(),
    cursor: handleSchema.optional(),
  })
  .refine((value) => {
    return Object.hasOwn(value, "path") !== Object.hasOwn(value, "cursor");
  });

export const sandboxFsListResultSchema = z
  .strictObject({
    listingId: handleSchema,
    entries: z
      .array(
        z.strictObject({
          nameToken: sandboxNameTokenSchema,
          displayName: z
            .string()
            .min(1)
            .max(SANDBOX_FS_LIMITS.maxDisplayNameBytes)
            .refine((name) => {
              return (
                new TextEncoder().encode(name).byteLength <=
                  SANDBOX_FS_LIMITS.maxDisplayNameBytes &&
                !Array.from(name).some((character) => {
                  const code = character.charCodeAt(0);
                  return code <= 31 || (code >= 127 && code <= 159);
                })
              );
            }),
          kind: z.enum(["directory", "file", "symlink", "other"]),
        }),
      )
      .max(SANDBOX_FS_LIMITS.maxEntries),
    nextCursor: handleSchema.nullable(),
  })
  .refine((result) => {
    return (
      new TextEncoder().encode(JSON.stringify(result)).byteLength +
        SANDBOX_CHANNEL_LIMITS.responseOverheadBytes <=
      SANDBOX_FS_LIMITS.maxResponseBytes
    );
  });
export const sandboxFsListCloseParamsSchema = z.strictObject({
  cursor: handleSchema,
});
export const sandboxFsListCloseResultSchema = z.strictObject({});

export const sandboxFsList = {
  category: "fs",
  categoryVersion: SANDBOX_FS_VERSION,
  operation: "list",
  origin: "external",
  params: sandboxFsListParamsSchema,
  result: sandboxFsListResultSchema,
} as const satisfies SandboxChannelOperation<
  z.infer<typeof sandboxFsListParamsSchema>,
  z.infer<typeof sandboxFsListResultSchema>
>;
export const sandboxFsListClose = {
  category: "fs",
  categoryVersion: SANDBOX_FS_VERSION,
  operation: "list.close",
  origin: "external",
  params: sandboxFsListCloseParamsSchema,
  result: sandboxFsListCloseResultSchema,
} as const satisfies SandboxChannelOperation<
  z.infer<typeof sandboxFsListCloseParamsSchema>,
  z.infer<typeof sandboxFsListCloseResultSchema>
>;
function fileOffset(value: string): boolean {
  return (
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n
  );
}

/** Native signed file offsets stay exact beyond JavaScript's integer range. */
export const sandboxFileOffsetSchema = z.string().max(19).refine(fileOffset);
export const sandboxFsOpenParamsSchema = z.strictObject({
  path: pathSchema.min(1),
  mode: z.enum(["download", "preview", "prefix"]),
});
export const sandboxFsOpenResultSchema = z
  .strictObject({
    handle: handleSchema,
    nameToken: sandboxNameTokenSchema,
    displayName: z
      .string()
      .min(1)
      .max(SANDBOX_FS_LIMITS.maxDisplayNameBytes)
      .refine((name) => {
        return (
          new TextEncoder().encode(name).byteLength <=
            SANDBOX_FS_LIMITS.maxDisplayNameBytes &&
          !Array.from(name).some((character) => {
            const code = character.charCodeAt(0);
            return code <= 31 || (code >= 127 && code <= 159);
          })
        );
      }),
    fileSize: sandboxFileOffsetSchema,
    selectedSize: sandboxFileOffsetSchema,
    truncated: z.boolean(),
  })
  .refine((value) => {
    if (!fileOffset(value.fileSize) || !fileOffset(value.selectedSize))
      return false;
    const full = BigInt(value.fileSize);
    const selected = BigInt(value.selectedSize);
    return selected <= full && value.truncated === selected < full;
  });
export const sandboxFsReadParamsSchema = z.strictObject({
  handle: handleSchema,
  offset: sandboxFileOffsetSchema,
  length: z.int().min(1).max(SANDBOX_FS_LIMITS.maxChunkBytes),
});
export const sandboxFsReadResultSchema = z
  .strictObject({
    offset: sandboxFileOffsetSchema,
    length: z.int().min(0).max(SANDBOX_FS_LIMITS.maxChunkBytes),
    data: z.string().max(4 * Math.ceil(SANDBOX_FS_LIMITS.maxChunkBytes / 3)),
  })
  .refine((result) => {
    if (result.data.length > 4 * Math.ceil(SANDBOX_FS_LIMITS.maxChunkBytes / 3))
      return false;
    try {
      const bytes = atob(result.data);
      return (
        bytes.length === result.length &&
        btoa(bytes) === result.data &&
        new TextEncoder().encode(JSON.stringify(result)).byteLength +
          SANDBOX_CHANNEL_LIMITS.responseOverheadBytes <=
          SANDBOX_FS_LIMITS.maxResponseBytes
      );
    } catch {
      return false;
    }
  });
export const sandboxFsHandleParamsSchema = z.strictObject({
  handle: handleSchema,
});
export const sandboxFsReleaseResultSchema = z.strictObject({});

export const sandboxFsOpen = {
  category: "fs",
  categoryVersion: SANDBOX_FS_VERSION,
  operation: "open",
  origin: "external",
  params: sandboxFsOpenParamsSchema,
  result: sandboxFsOpenResultSchema,
} as const satisfies SandboxChannelOperation<
  z.infer<typeof sandboxFsOpenParamsSchema>,
  z.infer<typeof sandboxFsOpenResultSchema>
>;
export const sandboxFsRead = {
  category: "fs",
  categoryVersion: SANDBOX_FS_VERSION,
  operation: "read",
  origin: "external",
  params: sandboxFsReadParamsSchema,
  result: sandboxFsReadResultSchema,
} as const satisfies SandboxChannelOperation<
  z.infer<typeof sandboxFsReadParamsSchema>,
  z.infer<typeof sandboxFsReadResultSchema>
>;
export const sandboxFsFinish = {
  category: "fs",
  categoryVersion: SANDBOX_FS_VERSION,
  operation: "finish",
  origin: "external",
  params: sandboxFsHandleParamsSchema,
  result: sandboxFsReleaseResultSchema,
} as const satisfies SandboxChannelOperation<
  z.infer<typeof sandboxFsHandleParamsSchema>,
  z.infer<typeof sandboxFsReleaseResultSchema>
>;
export const sandboxFsClose = {
  ...sandboxFsFinish,
  operation: "close",
} as const;
export const sandboxFsCategory = {
  category: "fs",
  version: SANDBOX_FS_VERSION,
  operations: [
    sandboxFsList,
    sandboxFsListClose,
    sandboxFsOpen,
    sandboxFsRead,
    sandboxFsFinish,
    sandboxFsClose,
  ],
  events: [],
} as const satisfies SandboxChannelCategoryContract;

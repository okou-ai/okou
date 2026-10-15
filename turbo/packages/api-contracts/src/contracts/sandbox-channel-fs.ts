import { z } from "zod";
import { SANDBOX_CHANNEL_LIMITS } from "./sandbox-channel";
import type {
  SandboxChannelCategoryContract,
  SandboxChannelOperation,
} from "./sandbox-channel";

export const SANDBOX_FS_VERSION = 2;
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

/** fs v2 paths are raw basename tokens relative to Guest /; [] denotes /. */
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
export const sandboxFsCategory = {
  category: "fs",
  version: SANDBOX_FS_VERSION,
  operations: [sandboxFsList, sandboxFsListClose],
  events: [],
} as const satisfies SandboxChannelCategoryContract;

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  findManagedSocialKitTool,
  socialKitRequestSchema,
  socialKitCollectionProviderLimitedReasonSchema,
  socialKitCollectionUncertaintySchema,
  type SocialKitRequest,
} from "@okouai/api-contracts/contracts/social";
import { socialPlatformSchema } from "@okouai/api-contracts/contracts/social-discovery";
import { InvalidArgumentError } from "commander";
import { z } from "zod";

import { getApiUrl } from "../../lib/api/config";
import { getOkouToken } from "../../lib/okou-env";
import {
  commentsIntent,
  parseSocialTarget,
  postsIntent,
  searchIntent,
  type SocialIntent,
} from "./intents";

const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const optionsSchema = z.strictObject({
  limit: count.positive(),
  date: z.string().optional(),
  fullDetails: z.boolean().optional(),
  hashtag: z.boolean().optional(),
  kind: z.string().optional(),
  sort: z.string().optional(),
  type: z.string().optional(),
});
const selectionSchema = z.strictObject({
  operation: z.enum(["posts", "search", "comments"]),
  platform: socialPlatformSchema,
  target: z.string(),
  options: optionsSchema,
});
const pageSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("more"),
    itemsReturned: count,
    reportedTotal: count.optional(),
    nextInput: z.union([
      z.strictObject({ cursor: z.string().min(1) }),
      z.strictObject({ page: count.positive() }),
    ]),
  }),
  z.strictObject({
    state: z.literal("complete"),
    itemsReturned: count,
    reportedTotal: count.optional(),
  }),
  z.strictObject({
    state: z.literal("provider_limited"),
    itemsReturned: count,
    reportedTotal: count.optional(),
    reason: socialKitCollectionProviderLimitedReasonSchema.optional(),
    uncertainty: socialKitCollectionUncertaintySchema.optional(),
    sourceLimit: z
      .strictObject({
        kind: z.literal("single_batch"),
        maxItems: count.positive(),
      })
      .optional(),
  }),
]);
const progressSchema = z.strictObject({
  pages: count,
  itemsReturned: count,
  itemsObserved: count,
  billingQuantity: count,
  creditsCharged: count,
});
const checkpointSchema = z.strictObject({
  createdAt: count,
  expiresAt: count,
  selection: selectionSchema,
  initialRequest: socialKitRequestSchema,
  pendingRequest: socialKitRequestSchema.nullable(),
  completedRequests: z.array(z.string()).max(100_000),
  bufferedItems: z.array(z.unknown()),
  context: z.record(z.string(), z.unknown()),
  lastPage: pageSchema.nullable(),
  progress: progressSchema,
  reportedTotal: count.optional(),
});
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  payload: z.string(),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type SavedCollection = z.infer<typeof checkpointSchema>;

export function collectionRequestIdentity(request: SocialKitRequest): string {
  return JSON.stringify(
    Object.entries(request.input)
      .filter(([key]) => {
        return key !== "limit";
      })
      .sort(([left], [right]) => {
        return left.localeCompare(right);
      }),
  );
}

function selectionIntent(
  selection: SavedCollection["selection"],
): SocialIntent {
  const options = { ...selection.options, platform: selection.platform };
  switch (selection.operation) {
    case "search":
      return searchIntent(selection.target, options);
    case "posts":
      return postsIntent(parseSocialTarget(selection.target), options);
    case "comments":
      return commentsIntent(parseSocialTarget(selection.target), options);
  }
}

export function checkpointIntent(
  saved: SavedCollection,
  limit: number,
): SocialIntent {
  const intent = selectionIntent(saved.selection);
  if (
    intent.platform !== saved.selection.platform ||
    intent.request.tool !== saved.initialRequest.tool ||
    collectionRequestIdentity(intent.request) !==
      collectionRequestIdentity(saved.initialRequest)
  ) {
    throw new InvalidArgumentError(
      "Checkpoint request is incompatible; start a new collection",
    );
  }
  requireCheckpointSupport(intent);
  if (saved.pendingRequest) {
    const input = Object.fromEntries(
      Object.entries(saved.pendingRequest.input).filter(([key]) => {
        return key !== "cursor" && key !== "page";
      }),
    );
    const request = socialKitRequestSchema.parse({
      tool: saved.pendingRequest.tool,
      input,
    });
    if (
      request.tool !== intent.request.tool ||
      collectionRequestIdentity(request) !==
        collectionRequestIdentity(intent.request) ||
      saved.completedRequests.includes(
        collectionRequestIdentity(saved.pendingRequest),
      )
    ) {
      throw new InvalidArgumentError(
        "Checkpoint continuation is incompatible or repeated; start a new collection",
      );
    }
  }
  return {
    ...intent,
    requestMetadata: { ...intent.requestMetadata, limit, resume: true },
  };
}

export function requireCheckpointSupport(intent: SocialIntent): void {
  const pagination = findManagedSocialKitTool(intent.request.tool)?.collection
    ?.pagination;
  if (!pagination || pagination.kind === "none") {
    throw new InvalidArgumentError(
      "This operation has no reviewed continuation support; omit --checkpoint and inspect okou social capabilities",
    );
  }
}

export function newCollectionCheckpoint(intent: SocialIntent): SavedCollection {
  const createdAt = Date.now();
  return checkpointSchema.parse({
    createdAt,
    expiresAt: createdAt + CHECKPOINT_LIFETIME_MS,
    selection: {
      operation: intent.operation,
      platform: intent.platform,
      target:
        intent.target.kind === "query"
          ? intent.target.query
          : intent.target.canonicalUrl,
      options: intent.requestMetadata,
    },
    initialRequest: intent.request,
    pendingRequest: null,
    completedRequests: [],
    bufferedItems: [],
    context: {},
    lastPage: null,
    progress: {
      pages: 0,
      itemsReturned: 0,
      itemsObserved: 0,
      billingQuantity: 0,
      creditsCharged: 0,
    },
  });
}

function fileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class CollectionCheckpoint {
  private constructor(
    readonly path: string,
    private readonly token: string,
    private readonly apiUrl: string,
    private replace: boolean,
  ) {}

  static async open(
    path: string,
    resume: boolean,
  ): Promise<CollectionCheckpoint> {
    const token = getOkouToken();
    if (!token) {
      throw new InvalidArgumentError(
        "Set OKOU_TOKEN before using a collection checkpoint",
      );
    }
    const absolute = resolve(path);
    const canonical = join(
      await realpath(dirname(absolute)),
      basename(absolute),
    );
    const checkpoint = new CollectionCheckpoint(
      canonical,
      token,
      await getApiUrl(),
      resume,
    );
    try {
      const lock = await open(`${canonical}.lock`, "wx", 0o600);
      await lock.close();
    } catch (error) {
      if (fileError(error, "EEXIST")) {
        throw new InvalidArgumentError(
          "Checkpoint is locked; wait for its active command. Inspect interrupted output before manually removing a stale .lock file",
        );
      }
      throw error;
    }
    try {
      const stat = await lstat(canonical).catch((error: unknown) => {
        if (fileError(error, "ENOENT")) return undefined;
        throw error;
      });
      if (stat && (!resume || !stat.isFile() || stat.nlink !== 1)) {
        throw new InvalidArgumentError(
          "Checkpoint must be a single regular file; use social resume for an existing checkpoint or choose a new path",
        );
      }
      if (resume && !stat) {
        throw new InvalidArgumentError(
          "Checkpoint was not found; use the saved path or start a new collection",
        );
      }
      return checkpoint;
    } catch (error) {
      await checkpoint.close();
      throw error;
    }
  }

  private signature(payload: string): Buffer {
    return createHmac("sha256", this.token)
      .update("okou-social-collection-v1\0")
      .update(this.apiUrl)
      .update("\0")
      .update(payload)
      .digest();
  }

  async read(): Promise<SavedCollection> {
    const file = await open(
      this.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let raw: unknown;
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > MAX_CHECKPOINT_BYTES
      ) {
        throw new InvalidArgumentError(
          "Checkpoint must be a regular file of at most 16 MiB",
        );
      }
      const buffer = Buffer.alloc(MAX_CHECKPOINT_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_CHECKPOINT_BYTES) {
        throw new InvalidArgumentError(
          "Checkpoint exceeds 16 MiB; start a new collection",
        );
      }
      raw = parseCheckpointJson(buffer.toString("utf8", 0, bytesRead));
    } finally {
      await file.close();
    }
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new InvalidArgumentError(
        "Unsupported or invalid checkpoint version/format; use a compatible CLI or start a new collection",
      );
    }
    if (
      !timingSafeEqual(
        this.signature(envelope.data.payload),
        Buffer.from(envelope.data.signature, "hex"),
      )
    ) {
      throw new InvalidArgumentError(
        "Checkpoint was altered or belongs to a different OKOU_TOKEN/API context; restore the original context or start a new collection",
      );
    }
    const parsed = checkpointSchema.safeParse(
      parseCheckpointJson(envelope.data.payload),
    );
    if (!parsed.success) {
      throw new InvalidArgumentError(
        "Checkpoint is incompatible with this CLI; use a compatible CLI or start a new collection",
      );
    }
    const saved = parsed.data;
    if (
      saved.expiresAt <= Date.now() ||
      saved.createdAt > Date.now() ||
      saved.expiresAt - saved.createdAt !== CHECKPOINT_LIFETIME_MS
    ) {
      throw new InvalidArgumentError(
        "Checkpoint expired or has invalid timestamps; start a new collection",
      );
    }
    if (!saved.pendingRequest && saved.bufferedItems.length === 0) {
      throw new InvalidArgumentError(
        "Checkpoint is exhausted or cannot continue; start a new collection only if needed",
      );
    }
    return saved;
  }

  async save(saved: SavedCollection): Promise<void> {
    const payload = JSON.stringify(checkpointSchema.parse(saved));
    const body = JSON.stringify({
      version: 1,
      payload,
      signature: this.signature(payload).toString("hex"),
    });
    if (Buffer.byteLength(body) > MAX_CHECKPOINT_BYTES) {
      throw new Error(
        "Checkpoint exceeds 16 MiB; accepted output is retained but continuation could not be saved",
      );
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }
      if (this.replace) {
        await rename(temporary, this.path);
      } else {
        await link(temporary, this.path);
        this.replace = true;
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!fileError(error, "ENOENT")) throw error;
      });
    }
  }

  async close(): Promise<void> {
    await unlink(`${this.path}.lock`).catch((error: unknown) => {
      if (!fileError(error, "ENOENT")) throw error;
    });
  }
}

function parseCheckpointJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new InvalidArgumentError(
      "Checkpoint contains invalid JSON; restore the original file or start a new collection",
    );
  }
}

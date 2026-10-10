import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import sharp from "sharp";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import {
  isMarkdownCoverSource,
  markdownCoverHtml,
  MARKDOWN_COVER_MAX_BYTES,
  MARKDOWN_COVER_RENDERER,
  MARKDOWN_COVER_VIEWPORT,
} from "../../lib/markdown-cover";
import { writeDb$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  isS3NotFoundError,
  putImmutableS3Object,
  S3ObjectSizeLimitError,
} from "../external/s3";
import {
  settle,
  safeSync,
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
} from "../utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  allocatePrivateArtifact$,
  privateArtifactRecord$,
  privateArtifactsBucket,
} from "./private-artifact-storage.service";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTEMPTS = 2;
const CLAIM_LIFETIME_MS = 120_000;
const filename = `${MARKDOWN_COVER_RENDERER}.png`;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const bindingSchema = z.object({
  sourceId: z.uuid(),
  sourceSha256: digestSchema,
  renderer: z.literal(MARKDOWN_COVER_RENDERER),
  attempts: z.number().int().positive().max(MAX_ATTEMPTS),
  startedAt: z.iso.datetime(),
  sha256: digestSchema.optional(),
});
const snapshotSchema = z.object({
  success: z.literal(true),
  result: z.object({
    content: z.string().min(1),
    screenshot: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4),
  }),
});

export interface MarkdownCoverSource {
  readonly id: string;
  readonly key: string;
  readonly filename: string;
  readonly contentType: string;
}
export interface MarkdownArtifactCover {
  readonly id: string;
  readonly key: string;
  readonly filename: string;
  readonly sha256: string;
  readonly sourceSha256: string;
}
interface CoverOwner {
  readonly userId: string;
  readonly orgId: string;
}
interface CoverInput extends CoverOwner {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly html: string;
}
interface CoverClaim {
  readonly status: "claimed";
  readonly bucket: string;
  readonly key: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly binding: z.infer<typeof bindingSchema>;
}

export const artifactContentCoversEnabled$ = command(
  async ({ set }, userId: string, orgId: string, signal: AbortSignal) => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      orgId,
      userId,
      signal,
    );
    signal.throwIfAborted();
    return isFeatureEnabled(FeatureSwitchKey.ArtifactPreviews, context);
  },
);

const readMarkdownCoverInput$ = command(
  async (
    { get, set },
    args: CoverOwner & { readonly source: MarkdownCoverSource },
    signal: AbortSignal,
  ): Promise<CoverInput | null> => {
    const { source } = args;
    if (!isMarkdownCoverSource(source)) {
      return null;
    }
    if (!source.key.startsWith(`private-artifacts/${source.id}/`)) {
      throw new Error("Markdown cover source identity mismatch");
    }
    if (
      !(await set(
        artifactContentCoversEnabled$,
        args.userId,
        args.orgId,
        signal,
      ))
    ) {
      return null;
    }
    if (!env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN")) {
      return null;
    }
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          privateArtifactsBucket(),
          source.key,
          MARKDOWN_COVER_MAX_BYTES,
          signal,
        ),
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!downloaded.ok) {
      if (
        downloaded.error instanceof S3ObjectSizeLimitError ||
        isS3NotFoundError(downloaded.error)
      ) {
        return null;
      }
      throw downloaded.error;
    }
    const decoded = safeSync(() => {
      return new TextDecoder("utf-8", { fatal: true }).decode(downloaded.value);
    });
    if (!("ok" in decoded) || decoded.ok.trim() === "") {
      return null;
    }
    const sourceSha256 = createHash("sha256")
      .update(downloaded.value)
      .digest("hex");
    return {
      userId: args.userId,
      orgId: args.orgId,
      sourceId: source.id,
      sourceSha256,
      id: uuidv5(
        `${source.id}:${sourceSha256}:${MARKDOWN_COVER_RENDERER}:1200x630`,
        uuidv5.URL,
      ),
      html: markdownCoverHtml(decoded.ok),
    };
  },
);

const cachedMarkdownCover$ = command(
  async ({ set }, input: CoverInput, signal: AbortSignal) => {
    const existing = await set(privateArtifactRecord$, input.id, signal);
    signal.throwIfAborted();
    if (
      existing &&
      (existing.userId !== input.userId || existing.orgId !== input.orgId)
    ) {
      throw new Error("Markdown cover owner mismatch");
    }
    const binding =
      existing?.metadata.markdownCover === undefined
        ? null
        : bindingSchema.parse(existing.metadata.markdownCover);
    if (
      binding &&
      (binding.sourceId !== input.sourceId ||
        binding.sourceSha256 !== input.sourceSha256)
    ) {
      throw new Error("Markdown cover content binding mismatch");
    }
    if (existing?.materializationStatus === "ready") {
      if (!binding?.sha256) {
        throw new Error("Ready Markdown cover has no content fingerprint");
      }
      return {
        binding,
        materializationStatus: existing.materializationStatus,
        cover: {
          id: input.id,
          key: existing.key,
          filename,
          sha256: binding.sha256,
          sourceSha256: input.sourceSha256,
        },
      };
    }
    return {
      binding,
      materializationStatus: existing?.materializationStatus,
      cover: null,
    };
  },
);

const claimMarkdownCover$ = command(
  async (
    { set },
    input: CoverInput,
    signal: AbortSignal,
  ): Promise<
    | CoverClaim
    | { readonly status: "ready"; readonly cover: MarkdownArtifactCover }
    | null
  > => {
    const cached = await set(cachedMarkdownCover$, input, signal);
    if (cached.cover) {
      return { status: "ready", cover: cached.cover };
    }
    const { binding } = cached;
    const startedAt = nowDate();
    const cutoff = new Date(
      startedAt.getTime() - CLAIM_LIFETIME_MS,
    ).toISOString();
    if (
      binding &&
      (binding.attempts >= MAX_ATTEMPTS ||
        (cached.materializationStatus === "pending" &&
          binding.startedAt >= cutoff))
    ) {
      return null;
    }
    const location = await set(
      allocatePrivateArtifact$,
      {
        id: input.id,
        userId: input.userId,
        orgId: input.orgId,
        filename,
        contentType: "image/png",
        size: 0,
      },
      signal,
    );
    signal.throwIfAborted();
    const nextBinding: z.infer<typeof bindingSchema> = {
      sourceId: input.sourceId,
      sourceSha256: input.sourceSha256,
      renderer: MARKDOWN_COVER_RENDERER,
      attempts: (binding?.attempts ?? 0) + 1,
      startedAt: startedAt.toISOString(),
    };
    const [claimed] = await set(writeDb$)
      .update(runUploadedFiles)
      .set({
        metadata: sql`jsonb_set(${runUploadedFiles.metadata}, '{markdownCover}', ${JSON.stringify(nextBinding)}::jsonb)`,
        materializationStatus: "pending",
        materializationError: null,
        updatedAt: startedAt,
      })
      .where(
        and(
          eq(runUploadedFiles.id, input.id),
          eq(runUploadedFiles.userId, input.userId),
          eq(runUploadedFiles.orgId, input.orgId),
          sql`(${runUploadedFiles.metadata}->'markdownCover' IS NULL OR (
        coalesce((${runUploadedFiles.metadata}->'markdownCover'->>'attempts')::int, 0) < ${MAX_ATTEMPTS}
        AND (${runUploadedFiles.materializationStatus} = 'failed' OR ${runUploadedFiles.metadata}->'markdownCover'->>'startedAt' < ${cutoff})
      ))`,
        ),
      )
      .returning({ id: runUploadedFiles.id });
    signal.throwIfAborted();
    return claimed
      ? {
          status: "claimed",
          bucket: location.bucket,
          key: location.key,
          metadata: location.metadata,
          binding: nextBinding,
        }
      : null;
  },
);

async function validateCover(image: Buffer): Promise<void> {
  const metadata = await sharp(image, {
    limitInputPixels: 1200 * 630,
  }).metadata();
  if (
    image.byteLength > MAX_IMAGE_BYTES ||
    metadata.format !== "png" ||
    metadata.width !== MARKDOWN_COVER_VIEWPORT.width ||
    metadata.height !== MARKDOWN_COVER_VIEWPORT.height ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new Error("Markdown cover renderer returned an invalid image");
  }
}

const requestMarkdownScreenshot$ = command(
  async (_, html: string, signal: AbortSignal): Promise<Buffer> => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env("R2_ACCOUNT_ID")}/browser-rendering/snapshot?cacheTTL=0`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          html,
          formats: ["content", "screenshot"],
          viewport: MARKDOWN_COVER_VIEWPORT,
          screenshotOptions: { type: "png", fullPage: false },
          rejectRequestPattern: [".*"],
          rejectResourceTypes: ["script"],
          actionTimeout: 30_000,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      },
    );
    signal.throwIfAborted();
    if (!response.ok) {
      throw new Error(
        `Markdown cover renderer returned HTTP ${response.status}`,
      );
    }
    const body = await readBoundedResponseText(response, 8 * 1024 * 1024);
    signal.throwIfAborted();
    if (body.kind === "too_large") {
      throw new Error("Markdown renderer response exceeds the byte limit");
    }
    const snapshot = snapshotSchema.parse(safeJsonParse(body.text));
    if (
      !snapshot.result.content.includes(
        `data-markdown-cover="${MARKDOWN_COVER_RENDERER}"`,
      )
    ) {
      throw new Error(
        "Markdown renderer did not return the submitted document",
      );
    }
    const image = Buffer.from(snapshot.result.screenshot, "base64");
    await validateCover(image);
    signal.throwIfAborted();
    return image;
  },
);

const persistMarkdownCover$ = command(
  async (
    { get, set },
    input: CoverInput,
    claim: CoverClaim,
    signal: AbortSignal,
  ): Promise<MarkdownArtifactCover | null> => {
    const rendered = await set(requestMarkdownScreenshot$, input.html, signal);
    signal.throwIfAborted();
    await get(
      putImmutableS3Object(claim.bucket, claim.key, rendered, "image/png", {
        signal,
        metadata: claim.metadata,
      }),
    );
    signal.throwIfAborted();
    // Immutable puts can reuse a successful prior attempt: version actual stored bytes.
    const image = await get(
      downloadS3BufferWithMaxBytes(
        claim.bucket,
        claim.key,
        MAX_IMAGE_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    await validateCover(image);
    signal.throwIfAborted();
    const sha256 = createHash("sha256").update(image).digest("hex");
    // Internal covers are not catalog artifacts. Complete this claim and its fingerprint atomically.
    const [changed] = await set(writeDb$)
      .update(runUploadedFiles)
      .set({
        metadata: sql`jsonb_set(${runUploadedFiles.metadata}, '{markdownCover}', ${JSON.stringify({ ...claim.binding, sha256 })}::jsonb)`,
        url: null,
        contentType: "image/png",
        sizeBytes: image.byteLength,
        materializationStatus: "ready",
        materializationError: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(runUploadedFiles.id, input.id),
          sql`${runUploadedFiles.metadata}->'markdownCover'->>'startedAt' = ${claim.binding.startedAt}`,
        ),
      )
      .returning({ id: runUploadedFiles.id });
    signal.throwIfAborted();
    if (!changed) {
      return null;
    }
    return {
      id: input.id,
      key: claim.key,
      filename,
      sha256,
      sourceSha256: input.sourceSha256,
    };
  },
);

const recordMarkdownCoverFailure$ = command(
  async ({ set }, id: string, claim: CoverClaim, signal: AbortSignal) => {
    await set(writeDb$)
      .update(runUploadedFiles)
      .set({
        materializationStatus: "failed",
        materializationError: {
          code: "preview_failed",
          message: "Markdown content cover rendering failed",
          retryable: claim.binding.attempts < MAX_ATTEMPTS,
        },
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(runUploadedFiles.id, id),
          sql`${runUploadedFiles.metadata}->'markdownCover'->>'startedAt' = ${claim.binding.startedAt}`,
        ),
      );
    signal.throwIfAborted();
  },
);

/** Caller has authorized the owned identity or exact copy in its parent snapshot. */
export const renderMarkdownArtifactCover$ = command(
  async (
    { set },
    args: CoverOwner & { readonly source: MarkdownCoverSource },
    signal: AbortSignal,
  ): Promise<MarkdownArtifactCover | null> => {
    const input = await set(readMarkdownCoverInput$, args, signal);
    if (!input) {
      return null;
    }
    const claim = await set(claimMarkdownCover$, input, signal);
    if (!claim) {
      return null;
    }
    if (claim.status === "ready") {
      return claim.cover;
    }
    return onRejection(
      set(persistMarkdownCover$, input, claim, signal),
      async () => {
        signal.throwIfAborted();
        await set(recordMarkdownCoverFailure$, input.id, claim, signal);
        signal.throwIfAborted();
      },
    );
  },
);

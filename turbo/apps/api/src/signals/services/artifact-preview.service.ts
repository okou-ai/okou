import { command } from "ccstate";
import { v5 as uuidv5 } from "uuid";
import { eq } from "drizzle-orm";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { z } from "zod";

import { env } from "../../lib/env";
import { publicArtifactsBaseUrlForBrand } from "../../lib/file-url";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { putImmutableS3Object } from "../external/s3";
import { safeJsonParse, tapError } from "../utils";
import { allocateArtifactObject$ } from "./artifact-storage.service";
import {
  allocatePrivateArtifact$,
  artifactFileReference,
  completePrivateArtifact$,
  privateArtifactCreationEnabled,
  privateArtifactRecord,
} from "./private-artifact-storage.service";
import { syncArtifactCatalogForFile$ } from "./artifact-catalog.service";
import { publishArtifactsChangedForRun } from "./artifact-realtime.service";
import { createPrivateHostedPreview$ } from "./private-hosted-preview.service";
import { extractPrivateVideoPoster$ } from "./private-video-preview.service";

const log = logger("artifacts:preview");

// Render at a full 1280-wide desktop layout for fidelity, but rasterize at half
// resolution (deviceScaleFactor 0.5 -> 640x400) since the grid only shows the
// image a few hundred px wide. WebP keeps the file small (~tens of KB).
const PREVIEW_VIEWPORT = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 0.5,
} as const;
const PREVIEW_IMAGE_CONTENT_TYPE = "image/webp";
const PREVIEW_IMAGE_EXTENSION = "webp";
const PREVIEW_IMAGE_BASENAME = "preview-v3";
const PREVIEW_WAF_COOKIE_NAME = "vm0_artifact_preview";
const SNAPSHOT_ACTION_TIMEOUT_MS = 30_000;
const PRIMARY_NAVIGATION_OPTIONS = {
  gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
} as const;
const NAVIGATION_TIMEOUT_RETRY_OPTIONS = {
  gotoOptions: { waitUntil: "domcontentloaded", timeout: 15_000 },
  waitForSelector: {
    selector: "body > *",
    visible: true,
    timeout: 10_000,
  },
} as const;

const browserSnapshotSchema = z.object({
  meta: z.object({
    status: z.number().optional(),
    title: z.string().optional(),
  }),
  success: z.literal(true),
  result: z.object({
    content: z.string().min(1),
    screenshot: z.string().min(1),
  }),
});

const browserSnapshotErrorSchema = z.object({
  errors: z.array(
    z.object({
      code: z.number(),
      detail: z.string().optional(),
    }),
  ),
});

// Poster versions are write-once. Renderer changes must use a new filename
// instead of replacing bytes behind an immutable CDN URL. The Cloudflare Media
// Transformations frame endpoint only outputs jpg/png.
const VIDEO_POSTER_FILENAME = "poster-v2.jpg";
const VIDEO_POSTER_CONTENT_TYPE = "image/jpeg";

export interface RenderArtifactPreviewArgs {
  // The run_uploaded_files row id; also namespaces the R2 object key.
  readonly id: string;
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly url: string;
  // Discriminates the renderer: `video/*` extracts a poster frame, otherwise a
  // Browser Rendering page screenshot.
  readonly contentType: string | null;
  readonly publicBrand: PublicBrand;
  // Versions the preview key so each deployment gets a fresh, CDN-cache-busting
  // URL instead of overwriting a stale object at a fixed key.
  readonly deploymentId?: string;
  readonly privateHosted?: boolean;
}

// Version the preview object by renderer and deployment so both renderer
// upgrades and site redeploys produce a fresh CDN URL.
function previewImageFilename(deploymentId?: string): string {
  const base = deploymentId
    ? `${PREVIEW_IMAGE_BASENAME}-${deploymentId}`
    : PREVIEW_IMAGE_BASENAME;
  return `${base}.${PREVIEW_IMAGE_EXTENSION}`;
}

function isVideoContentType(contentType: string | null): boolean {
  return contentType?.startsWith("video/") ?? false;
}

// Cloudflare Media Transformations rejects input at or above this size with
// `9402`, so a larger artifact can never yield a poster frame either.
export const VIDEO_POSTER_MAX_INPUT_BYTES = 104_857_600;

// Cloudflare Media Transformations only decodes MP4 input, so a WebM artifact
// can never yield a poster frame. Recognizing that up front avoids a request
// that always fails and a warning nobody can act on.
function canExtractVideoPoster(contentType: string | null): boolean {
  return !(contentType?.startsWith("video/webm") ?? false);
}

// Extract a poster frame from a video via Cloudflare Media Transformations.
// This is a public transform URL on the artifacts CDN (no auth), the video
// sibling of the `/cdn-cgi/image/` resizing already used for images.
async function extractVideoPoster(
  videoUrl: string,
  publicBrand: PublicBrand,
  signal: AbortSignal,
): Promise<Buffer> {
  const base = publicArtifactsBaseUrlForBrand(publicBrand);
  const transformUrl = `${base}/cdn-cgi/media/mode=frame,time=1s,width=640,format=jpg/${videoUrl}`;
  const response = await fetch(transformUrl, { signal });
  if (!response.ok) {
    throw new Error(
      `media frame extraction failed (${response.status}): ${await response.text()}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

const renderVideoPoster$ = command(
  async ({ set }, args: RenderArtifactPreviewArgs, signal: AbortSignal) => {
    if (!canExtractVideoPoster(args.contentType)) {
      return null;
    }
    const reference = artifactFileReference(args.url);
    if (reference) {
      if (!reference.id) {
        return null;
      }
      const image = await set(
        extractPrivateVideoPoster$,
        {
          id: reference.id,
          userId: args.userId,
          orgId: args.orgId,
        },
        signal,
      );
      return image ? { image, isPrivate: true } : null;
    }
    return {
      image: await extractVideoPoster(args.url, args.publicBrand, signal),
      isPrivate: false,
    };
  },
);

function isCloudflareChallenge(content: string, title?: string): boolean {
  const page = `${title ?? ""}\n${content}`.toLowerCase();
  const hasChallengeCopy = [
    "performing security verification",
    "incompatible browser extension or network configuration",
    "verify you are human",
    "checking your browser",
    "just a moment",
  ].some((marker) => {
    return page.includes(marker);
  });
  const hasChallengeImplementation = [
    "challenges.cloudflare.com",
    "/cdn-cgi/challenge-platform/",
    "challenge-platform",
    "cf-chl-",
    "__cf_chl_",
  ].some((marker) => {
    return page.includes(marker);
  });
  return hasChallengeCopy && hasChallengeImplementation;
}

function isNavigationTimeoutResponse(
  status: number,
  responseBody: string,
): boolean {
  if (status !== 422) {
    return false;
  }
  const parsed = browserSnapshotErrorSchema.safeParse(
    safeJsonParse(responseBody),
  );
  return (
    parsed.success &&
    parsed.data.errors.some((error) => {
      return (
        error.code === 6002 &&
        error.detail?.startsWith("Navigation timeout") === true
      );
    })
  );
}

type SnapshotNavigationOptions =
  | typeof PRIMARY_NAVIGATION_OPTIONS
  | typeof NAVIGATION_TIMEOUT_RETRY_OPTIONS;

interface FetchArtifactSnapshotArgs {
  readonly token: string;
  readonly wafSecret: string;
  readonly url: string;
  readonly previewUrl: URL;
  readonly navigationOptions: SnapshotNavigationOptions;
}

function fetchArtifactSnapshot(
  {
    token,
    wafSecret,
    url,
    previewUrl,
    navigationOptions,
  }: FetchArtifactSnapshotArgs,
  signal: AbortSignal,
): Promise<Response> {
  const accountId = env("R2_ACCOUNT_ID");
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/snapshot?cacheTTL=0`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        cookies: [
          {
            name: PREVIEW_WAF_COOKIE_NAME,
            value: wafSecret,
            url: previewUrl.origin,
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
          },
        ],
        formats: ["content", "screenshot"],
        viewport: PREVIEW_VIEWPORT,
        ...navigationOptions,
        actionTimeout: SNAPSHOT_ACTION_TIMEOUT_MS,
        screenshotOptions: { type: "webp", quality: 80 },
      }),
      signal,
    },
  );
}

async function renderArtifactSnapshot(
  token: string,
  wafSecret: string,
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const previewUrl = new URL(url);
  const hostDomains = [env("ZERO_HOST_DOMAIN"), env("OKOU_PUBLIC_HOST_DOMAIN")];
  if (
    previewUrl.protocol !== "https:" ||
    !hostDomains.some((hostDomain) => {
      return previewUrl.hostname.endsWith(`.${hostDomain}`);
    })
  ) {
    throw new Error("artifact preview URL must use a hosted-site domain");
  }

  let response = await fetchArtifactSnapshot(
    {
      token,
      wafSecret,
      url,
      previewUrl,
      navigationOptions: PRIMARY_NAVIGATION_OPTIONS,
    },
    signal,
  );
  if (!response.ok) {
    const responseBody = await response.text();
    // Keep the extra Browser Rendering request exclusive to navigation: action
    // and request-stage timeouts need different fixes and should not double cost.
    if (!isNavigationTimeoutResponse(response.status, responseBody)) {
      throw new Error(
        `browser-rendering snapshot failed (${response.status}): ${responseBody}`,
      );
    }
    response = await fetchArtifactSnapshot(
      {
        token,
        wafSecret,
        url,
        previewUrl,
        navigationOptions: NAVIGATION_TIMEOUT_RETRY_OPTIONS,
      },
      signal,
    );
  }
  if (!response.ok) {
    throw new Error(
      `browser-rendering snapshot failed (${response.status}): ${await response.text()}`,
    );
  }

  const responseBody: unknown = await response.json();
  const snapshot = browserSnapshotSchema.parse(responseBody);
  if (snapshot.meta.status !== undefined && snapshot.meta.status >= 400) {
    throw new Error(
      `browser-rendering snapshot returned page status ${snapshot.meta.status}`,
    );
  }
  if (isCloudflareChallenge(snapshot.result.content, snapshot.meta.title)) {
    throw new Error(
      "browser-rendering snapshot returned a Cloudflare challenge",
    );
  }
  return Buffer.from(snapshot.result.screenshot, "base64");
}

/**
 * Render a static preview image for a single hosted-site/HTML artifact row,
 * upload it according to the artifact storage policy, and persist its stable
 * URL on the row. Returns false (no-op) when the browser-rendering
 * token is unset, or when the video container has no poster frame we can
 * extract. Keyed by the row id so it always targets the exact artifact of that
 * run.
 */
const renderAndStoreArtifactPreview$ = command(
  async (
    { get, set },
    args: RenderArtifactPreviewArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const isVideo = isVideoContentType(args.contentType);
    let privateSource = args.privateHosted === true;
    let image: Buffer;
    let filename: string;
    let contentType: string;
    if (isVideo) {
      const poster = await set(renderVideoPoster$, args, signal);
      if (!poster) {
        return false;
      }
      image = poster.image;
      privateSource ||= poster.isPrivate;
      filename = VIDEO_POSTER_FILENAME;
      contentType = VIDEO_POSTER_CONTENT_TYPE;
    } else {
      const token = env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
      if (!token) {
        return false;
      }
      const wafSecret = env("ARTIFACT_PREVIEW_WAF_SECRET");
      if (!wafSecret) {
        throw new Error(
          "ARTIFACT_PREVIEW_WAF_SECRET is required when browser rendering is configured",
        );
      }
      let renderUrl = args.url;
      if (args.privateHosted) {
        if (!args.deploymentId) {
          throw new Error("Private site previews require a deployment");
        }
        const preview = await set(
          createPrivateHostedPreview$,
          {
            deploymentId: args.deploymentId,
            userId: args.userId,
            orgId: args.orgId,
          },
          signal,
        );
        if (!preview) {
          return false;
        }
        renderUrl = preview.url;
      }
      image = await renderArtifactSnapshot(token, wafSecret, renderUrl, signal);
      filename = previewImageFilename(args.deploymentId);
      contentType = PREVIEW_IMAGE_CONTENT_TYPE;
    }
    signal.throwIfAborted();

    const privateId = uuidv5(`${args.id}:${filename}`, uuidv5.URL);
    const existing = await get(privateArtifactRecord(privateId));
    signal.throwIfAborted();
    const privatePreview =
      privateSource ||
      existing !== null ||
      (await get(privateArtifactCreationEnabled(args.orgId, args.userId)));
    signal.throwIfAborted();
    const artifact = privatePreview
      ? await set(
          allocatePrivateArtifact$,
          {
            userId: args.userId,
            orgId: args.orgId,
            id: privateId,
            filename,
            contentType,
            size: image.byteLength,
            publicBrand: args.publicBrand,
          },
          signal,
        )
      : {
          ...(await set(
            allocateArtifactObject$,
            {
              userId: args.userId,
              id: args.id,
              filename,
              variant: filename,
              publicBrand: args.publicBrand,
            },
            signal,
          )),
          bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        };
    await get(
      putImmutableS3Object(artifact.bucket, artifact.key, image, contentType, {
        signal,
        metadata: artifact.metadata,
      }),
    );
    signal.throwIfAborted();

    if (privatePreview) {
      await set(
        completePrivateArtifact$,
        {
          id: artifact.id,
          url: null,
          contentType,
          size: image.byteLength,
        },
        signal,
      );
    }
    const db = set(writeDb$);
    await db
      .update(runUploadedFiles)
      .set({
        previewImageUrl: artifact.url,
        updatedAt: nowDate(),
      })
      .where(eq(runUploadedFiles.id, args.id));
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, args.id, signal);
    await publishArtifactsChangedForRun(db, args.runId, signal);
    return true;
  },
);

/**
 * Fire-and-forget the creation-time preview render on a detached signal via
 * waitUntil, so it runs to completion after the response returns rather than
 * being cancelled with the request. No-op when there is nothing to render.
 */
export const scheduleArtifactPreviewRender$ = command(
  ({ set }, args: RenderArtifactPreviewArgs | null): void => {
    if (!args) {
      return;
    }
    waitUntil(
      tapError(
        set(renderAndStoreArtifactPreview$, args, new AbortController().signal),
        (error) => {
          log.warn("Failed to render artifact preview", {
            artifactId: args.id,
            url: args.url,
            contentType: args.contentType,
            error: (error instanceof Error
              ? error.message
              : String(error)
            ).replace(/pv-[a-f0-9]{48}/gu, "pv-[redacted]"),
          });
        },
      ),
    );
  },
);

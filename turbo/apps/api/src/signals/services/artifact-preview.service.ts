import { performance } from "node:perf_hooks";

import { command } from "ccstate";
import { delay } from "signal-timers";
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
  resolveArtifactFileReference,
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
// Cloudflare starts this timer only once navigation has finished, and runs it
// over the action itself: content extraction and the screenshot. Its own
// ceiling is 5 minutes, but the render runs inside `waitUntil` on a Vercel
// function budgeted at 300s, and a function killed mid-render loses the failure
// record that #34591 exists to produce. Only the first request gets this
// budget; the retries that can follow it are bounded separately, and the
// request-budget comment below states the resulting ceiling.
const SNAPSHOT_ACTION_TIMEOUT_MS = 120_000;
const PRIMARY_NAVIGATION_OPTIONS = {
  gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
} as const;
// `domcontentloaded` fires before late content paints, so this retry needs a
// settle window. It must not be `waitForSelector` on `body > *`: Browser
// Rendering applies Puppeteer semantics, which resolve the selector's *first*
// match and then wait for that one element to become visible. Whichever node a
// document happens to open its body with decides the outcome, and an icon
// sprite (`<svg display:none>`) or a leading script can never satisfy the
// visibility check, so ready pages burned the probe's whole budget and failed
// the retry. A fixed wait does not depend on document shape. 3s covers every
// failing artifact measured here, whose `networkidle2` came at p90 1.8s and at
// most 2.7s from navigation start.
const NAVIGATION_TIMEOUT_RETRY_OPTIONS = {
  gotoOptions: { waitUntil: "domcontentloaded", timeout: 15_000 },
  waitForTimeout: 3000,
} as const;

// A render gets three requests in total, and the navigation, rate limit and
// action retries all draw on that one budget so they cannot multiply into
// repeated render charges. The waiting ceilings come from the function
// lifetime #34772 measured: the longest render observed in production is ~121s
// and the surrounding storage and database work adds ~15s, so 45s of total
// waiting keeps the longest chain near 211s of the 300s budget: a 20s primary
// navigation timeout, the retry's 15s navigation, 3s settle and full action
// budget, then an action retry on that same profile under the short budget.
// A wait that outlives the function loses the failure record #34591 exists to
// produce, which is why a stated wait past the ceiling stops instead of
// sleeping.
const MAX_SNAPSHOT_REQUESTS = 3;
const RATE_LIMIT_MIN_DELAY_MS = 1000;
const RATE_LIMIT_MAX_DELAY_MS = 30_000;
const RATE_LIMIT_TOTAL_DELAY_BUDGET_MS = 45_000;
// 2s then 8s when the response states no wait. Quadrupling gets the second
// attempt clear of a short burst without spending the whole budget.
const RATE_LIMIT_BACKOFF_BASE_MS = 2000;
const RATE_LIMIT_BACKOFF_FACTOR = 4;
const RATE_LIMIT_MAX_JITTER_MS = 500;

// The `detail` on an action-stage timeout. Unlike `Navigation timeout ...` and
// `Waiting for selector ...` it names no timer, which is why it was previously
// read as a stall no second request could fix.
const SNAPSHOT_REQUEST_TIMEOUT_DETAIL = "Request timed out";
// The action retry gets a short budget, for two independent reasons. A bounded
// experiment replayed the four deployments that produced this failure on
// 2026-09-17 with the identical request: all four returned in 3.7-8.2s, so a
// session that is going to finish finishes far inside this. And the primary has
// already spent 120s by the time this runs, so repeating that budget would put
// a plain primary-then-retry render near 256s of the 300s function budget and
// risk losing the failure record #34591 exists to produce. 20s keeps that
// chain near 157s; the request-budget comment above states the longest chain.
const ACTION_TIMEOUT_RETRY_MS = 20_000;

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
  async (
    { get, set },
    args: RenderArtifactPreviewArgs,
    signal: AbortSignal,
  ) => {
    if (!canExtractVideoPoster(args.contentType)) {
      return null;
    }
    const reference = await get(resolveArtifactFileReference(args.url, signal));
    signal.throwIfAborted();
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

/**
 * An action-stage timeout. The status and code alone cannot separate this from
 * the navigation and selector timers, which share `6002`, so the exact detail
 * is the gate. A rate limit is a 429 and never reaches here.
 */
function isActionTimeoutResponse(
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
        error.code === 6002 && error.detail === SNAPSHOT_REQUEST_TIMEOUT_DETAIL
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
  // Required rather than defaulted: the request loop is the only thing that
  // decides a budget, and it always states one.
  readonly actionTimeout: number;
}

function fetchArtifactSnapshot(
  {
    token,
    wafSecret,
    url,
    previewUrl,
    navigationOptions,
    actionTimeout,
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
        actionTimeout,
        screenshotOptions: { type: "webp", quality: 80 },
      }),
      signal,
    },
  );
}

/** Which request profile produced an observation. */
type SnapshotAttempt = "primary" | "navigation-retry" | "action-retry";

interface SnapshotFailure {
  readonly attempt: SnapshotAttempt;
  readonly status: number;
  readonly elapsedMs: number;
  readonly body: string;
  // Present only on a rate-limited response, and only when Cloudflare sends
  // them: the wait it will honour, and the name of the quota that was hit.
  readonly retryAfterSeconds?: number;
  readonly rateLimitPolicy?: string;
}

/**
 * Cloudflare documents `retry-after` on a throttled client API response as
 * whole seconds until capacity returns, so only that form is read. A malformed
 * value is treated as absent rather than as an immediate retry.
 */
function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }
  return Number(value.trim());
}

/**
 * A 429 is an admission rejection: the gateway refused the request before any
 * browser work, so the identical request can succeed once its window passes.
 * The status is the gate rather than the body's `971`, because that is
 * Cloudflare's generic client API throttle code and is not specific to this
 * endpoint.
 */
function isRateLimitedResponse(status: number): boolean {
  return status === 429;
}

/**
 * Prefer the wait Cloudflare states over a guess. A stated wait beyond the
 * ceiling, or one that would overrun the render's total waiting budget, cannot
 * be absorbed here, so those stop instead of waiting.
 */
function rateLimitDelayMs(
  failure: SnapshotFailure,
  retries: number,
  totalDelayMs: number,
): number | null {
  const statedMs =
    failure.retryAfterSeconds === undefined
      ? undefined
      : failure.retryAfterSeconds * 1000;
  if (statedMs !== undefined && statedMs > RATE_LIMIT_MAX_DELAY_MS) {
    return null;
  }
  const waitMs =
    statedMs === undefined
      ? RATE_LIMIT_BACKOFF_BASE_MS * RATE_LIMIT_BACKOFF_FACTOR ** retries +
        Math.floor(Math.random() * (RATE_LIMIT_MAX_JITTER_MS + 1))
      : Math.max(statedMs, RATE_LIMIT_MIN_DELAY_MS);
  return totalDelayMs + waitMs > RATE_LIMIT_TOTAL_DELAY_BUDGET_MS
    ? null
    : waitMs;
}

type SnapshotAttemptResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly failure: SnapshotFailure };

/**
 * Browser Rendering reports every timer as `6002` and distinguishes them only
 * through `detail`, while the request runs independent navigation, selector and
 * action timers. Carry the stage and the duration on the error so the one warn
 * record this render already emits can be grouped by timer, which a message
 * string cannot be. The transport status and the rate-limit headers travel the
 * same way: a throttled response carries no `detail`, and its quota name is the
 * field that separates a per-token limit from a per-IP one.
 */
class ArtifactSnapshotError extends Error {
  readonly attempt: SnapshotAttempt;
  readonly status: number;
  readonly elapsedMs: number;
  readonly errorCode: number | undefined;
  readonly errorDetail: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly rateLimitPolicy: string | undefined;

  constructor(failure: SnapshotFailure) {
    super(
      `browser-rendering snapshot failed (${failure.status}): ${failure.body}`,
    );
    this.name = "ArtifactSnapshotError";
    this.attempt = failure.attempt;
    this.status = failure.status;
    this.elapsedMs = failure.elapsedMs;
    this.retryAfterSeconds = failure.retryAfterSeconds;
    this.rateLimitPolicy = failure.rateLimitPolicy;
    const parsed = browserSnapshotErrorSchema.safeParse(
      safeJsonParse(failure.body),
    );
    const error = parsed.success ? parsed.data.errors[0] : undefined;
    this.errorCode = error?.code;
    this.errorDetail = error?.detail;
  }
}

/** Promotes a snapshot failure's carried stage and duration into log fields. */
function snapshotFailureLogFields(error: unknown): {
  readonly attempt?: SnapshotAttempt;
  readonly status?: number;
  readonly elapsedMs?: number;
  readonly errorCode?: number;
  readonly errorDetail?: string;
  readonly retryAfterSeconds?: number;
  readonly rateLimitPolicy?: string;
} {
  if (!(error instanceof ArtifactSnapshotError)) {
    return {};
  }
  return {
    attempt: error.attempt,
    status: error.status,
    elapsedMs: error.elapsedMs,
    ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }),
    ...(error.errorDetail === undefined
      ? {}
      : { errorDetail: error.errorDetail }),
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
    ...(error.rateLimitPolicy === undefined
      ? {}
      : { rateLimitPolicy: error.rateLimitPolicy }),
  };
}

/**
 * Cloudflare responds only once the render finishes, so this duration is the
 * render itself rather than transport. Reading the failure body here also gives
 * the retry gate and the thrown error one shared copy instead of consuming the
 * stream separately.
 */
async function observeArtifactSnapshot(
  args: FetchArtifactSnapshotArgs,
  attempt: SnapshotAttempt,
  signal: AbortSignal,
): Promise<SnapshotAttemptResult> {
  const startedAt = performance.now();
  const response = await fetchArtifactSnapshot(args, signal);
  if (response.ok) {
    return { ok: true, response };
  }
  const body = await response.text();
  const retryAfterSeconds = parseRetryAfterSeconds(
    response.headers.get("retry-after"),
  );
  const rateLimitPolicy = response.headers.get("ratelimit-policy");
  return {
    ok: false,
    failure: {
      attempt,
      status: response.status,
      elapsedMs: Math.round(performance.now() - startedAt),
      body,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      ...(rateLimitPolicy === null ? {} : { rateLimitPolicy }),
    },
  };
}

/**
 * Issue the snapshot request, absorbing the three failures another request can
 * actually fix: a navigation-stage timeout, which needs a different navigation
 * profile; a gateway rate limit, which needs time; and an action-stage timeout,
 * which needs nothing but a second session. That last one used to stop here on
 * the reasoning that it was a stall a repeat could not fix. A bounded
 * experiment against the four deployments it hit on 2026-09-17 replayed the
 * identical request and all four rendered in 3.7-8.2s, so the session is what
 * fails, not the page. Everything else still stops here.
 */
async function requestArtifactSnapshot(
  requestArgs: Omit<
    FetchArtifactSnapshotArgs,
    "navigationOptions" | "actionTimeout"
  >,
  signal: AbortSignal,
): Promise<Response> {
  let navigationOptions: SnapshotNavigationOptions = PRIMARY_NAVIGATION_OPTIONS;
  let attemptName: SnapshotAttempt = "primary";
  let actionTimeout = SNAPSHOT_ACTION_TIMEOUT_MS;
  let navigationRetried = false;
  let actionRetried = false;
  let rateLimitRetries = 0;
  let totalDelayMs = 0;
  for (let request = 1; ; request += 1) {
    const attempt = await observeArtifactSnapshot(
      { ...requestArgs, navigationOptions, actionTimeout },
      attemptName,
      signal,
    );
    if (attempt.ok) {
      return attempt.response;
    }
    const { failure } = attempt;
    if (request >= MAX_SNAPSHOT_REQUESTS) {
      throw new ArtifactSnapshotError(failure);
    }
    if (isRateLimitedResponse(failure.status)) {
      const waitMs = rateLimitDelayMs(failure, rateLimitRetries, totalDelayMs);
      if (waitMs === null) {
        throw new ArtifactSnapshotError(failure);
      }
      await delay(waitMs, { signal });
      totalDelayMs += waitMs;
      rateLimitRetries += 1;
      continue;
    }
    if (isActionTimeoutResponse(failure.status, failure.body)) {
      // A second full budget cannot fit in the function, so one repeat under
      // the short budget is the whole allowance regardless of what remains of
      // the shared request budget. Navigation already succeeded to reach the
      // action stage, so this keeps whichever navigation profile the render had
      // reached rather than resetting to the primary one.
      if (actionRetried) {
        throw new ArtifactSnapshotError(failure);
      }
      actionRetried = true;
      actionTimeout = ACTION_TIMEOUT_RETRY_MS;
      attemptName = "action-retry";
      continue;
    }
    if (
      navigationRetried ||
      !isNavigationTimeoutResponse(failure.status, failure.body)
    ) {
      throw new ArtifactSnapshotError(failure);
    }
    navigationRetried = true;
    navigationOptions = NAVIGATION_TIMEOUT_RETRY_OPTIONS;
    attemptName = "navigation-retry";
  }
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

  const response = await requestArtifactSnapshot(
    { token, wafSecret, url, previewUrl },
    signal,
  );

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
            ...snapshotFailureLogFields(error),
          });
        },
      ),
    );
  },
);

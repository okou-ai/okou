import { Buffer } from "node:buffer";

import { delay } from "signal-timers";
import { z } from "zod";
import {
  introVideoAvatarSchema,
  introVideoAvatarTypeSchema,
  type IntroVideoAvatarType,
  introVideoStyleSchema,
} from "@okouai/api-contracts/contracts/intro-video-presenter";

import { logger } from "../../lib/log";
import { redactPresignedUrls } from "../../lib/presigned-url-redaction";
import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";

const L = logger("HeyGen");

const HEYGEN_API_BASE_URL = "https://api.heygen.com/v3";
const HEYGEN_AVATAR_LOOKS_URL = `${HEYGEN_API_BASE_URL}/avatars/looks`;
const HEYGEN_VIDEOS_URL = `${HEYGEN_API_BASE_URL}/videos`;
const HEYGEN_VIDEO_AGENTS_URL = `${HEYGEN_API_BASE_URL}/video-agents`;
const HEYGEN_VIDEO_AGENT_STYLES_URL = `${HEYGEN_API_BASE_URL}/video-agents/styles`;
const HEYGEN_VOICES_URL = `${HEYGEN_API_BASE_URL}/voices`;
const HEYGEN_VOICE_SPEECH_URL = `${HEYGEN_VOICES_URL}/speech`;
const HEYGEN_AVATAR_PAGE_SIZE = 50;
const HEYGEN_RATE_LIMIT_RETRY_MAX_MS = 30_000;
/** HeyGen's maximum voice page; the widest scan per request while filling a page. */
const HEYGEN_VOICE_SCAN_PAGE_SIZE = 100;
/** Bounds how many provider pages one catalog request may scan before yielding. */
const HEYGEN_CATALOG_SCAN_LIMIT = 10;
/** Default-voice lookups run per avatar page, so keep the fan-out bounded. */
const HEYGEN_VOICE_LOOKUP_BATCH_SIZE = 8;

type HeyGenErrorStatus = 400 | 502 | 503;

interface HeyGenErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

export interface HeyGenErrorResponse {
  readonly status: HeyGenErrorStatus;
  readonly body: HeyGenErrorBody;
}

interface HeyGenAvatarVideoOptions {
  readonly avatarId: string;
  readonly audioUrl: string;
  readonly aspectRatio: "portrait" | "landscape" | "square";
  readonly videoName: string | undefined;
}

interface HeyGenAvatarVideoHandle {
  readonly videoId: string;
}

interface HeyGenVideoAgentOptions {
  readonly prompt: string;
  readonly styleId: string;
  readonly avatarId?: string;
  readonly voiceId?: string;
  readonly orientation: "landscape" | "portrait";
  readonly fileUrls: readonly string[];
}

export interface HeyGenVideoAgentSession {
  readonly sessionId: string;
  // Preserve unknown states so reconciliation can report them without resubmitting.
  readonly status: string;
  readonly videoId: string | null;
}

interface HeyGenAvatarLook {
  readonly id: string;
  readonly groupId: string | null;
  readonly defaultVoiceId: string | null;
}

const heyGenVideoAgentSessionSchema = z.object({
  data: z.object({
    session_id: z.string().trim().min(1),
    status: z.string().trim().min(1),
    video_id: z.string().trim().min(1).nullish(),
  }),
});

const heyGenVideoAgentCallbackSchema = z.object({
  event_type: z.enum(["video_agent.success", "video_agent.fail"]),
  callback_id: z.string().trim().min(1).nullish(),
  event_data: z
    .object({
      callback_id: z.string().trim().min(1).nullish(),
      session_id: z.string().trim().min(1).nullish(),
      video_id: z.string().trim().min(1).nullish(),
    })
    .nullish(),
});

const heyGenAvatarLookSchema = z.object({
  data: z.object({
    id: z.string().trim().min(1),
    group_id: z.string().trim().min(1).nullish(),
    default_voice_id: z.string().trim().min(1).nullish(),
    status: z.string().trim().min(1).nullish(),
  }),
});

const heyGenVideoAgentVoiceSchema = z.object({
  data: z.object({
    voice_id: z.string().trim().min(1),
    name: z.string().trim().min(1).nullish(),
    status: z.string().trim().min(1).nullish(),
  }),
});

export type HeyGenAvatarVideoStatus =
  | { readonly kind: "pending" }
  | {
      readonly kind: "failed";
      readonly message: string;
    }
  | {
      readonly kind: "completed";
      readonly videoId: string;
      readonly sourceUrl: string;
      readonly durationSeconds: number;
    };

interface HeyGenDownloadedAvatarVideo {
  readonly videoBytes: Buffer;
  readonly contentType: "video/webm";
  readonly sourceUrl: string;
  readonly providerVideoId: string;
  readonly durationSeconds: number;
}

interface HeyGenVoiceCatalogOptions {
  readonly token: string | undefined;
  readonly pageSize: number;
  readonly language: string | undefined;
  readonly gender: "female" | "male" | undefined;
}

interface HeyGenPublicVoice {
  readonly id: string;
  readonly name: string;
  readonly sampleUrl?: string;
  readonly language?: string;
  readonly gender?: "female" | "male";
}

interface HeyGenPublicVoicePage {
  readonly voices: readonly HeyGenPublicVoice[];
  readonly hasMore: boolean;
  readonly nextToken: string | null;
}

interface HeyGenAvatarCatalogOptions {
  readonly token: string | undefined;
  readonly pageSize: number;
  readonly groupId?: string;
}

interface HeyGenPublicAvatar {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly defaultVoiceId: string;
  readonly defaultVoiceName?: string;
  readonly defaultVoiceSampleUrl?: string;
  readonly previewImageUrl?: string;
  readonly previewVideoUrl?: string;
  readonly gender?: "female" | "male";
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly preferredOrientation?: "landscape" | "portrait" | "square";
}

interface HeyGenPublicAvatarPage {
  readonly avatars: readonly HeyGenPublicAvatar[];
  readonly hasMore: boolean;
  readonly nextToken: string | null;
}

interface HeyGenStyleCatalogOptions {
  readonly token: string | undefined;
  readonly pageSize: number;
}

interface HeyGenPublicStyle {
  readonly id: string;
  readonly name: string;
  readonly thumbnailUrl?: string;
  readonly previewVideoUrl?: string;
  readonly tags: readonly string[];
  readonly aspectRatio?: "16:9" | "9:16" | "1:1";
}

interface HeyGenPublicStylePage {
  readonly styles: readonly HeyGenPublicStyle[];
  readonly hasMore: boolean;
  readonly nextToken: string | null;
}

interface HeyGenSpeechOptions {
  readonly voiceId: string;
  readonly text: string;
}

export interface HeyGenGeneratedSpeech {
  readonly audioBytes: Buffer;
  readonly contentType: "audio/mpeg" | "audio/wav";
  readonly sourceUrl: string;
  readonly providerRequestId: string | undefined;
  readonly durationSeconds: number;
}

interface HeyGenRequestOptions {
  readonly method: "GET" | "POST";
  readonly url: URL | string;
  readonly body?: string;
  readonly idempotencyKey?: string;
  readonly retryRateLimit: boolean;
}

/**
 * Every HeyGen failure funnels through one shared error wrapper, so a status
 * alone cannot say which call failed. A static label per call site keeps that
 * attribution in the log without putting provider resource ids in it.
 */
type HeyGenOperation =
  | "generate-speech"
  | "get-avatar-look"
  | "get-avatar-video-status"
  | "get-video-agent-session"
  | "get-video-agent-voice"
  | "get-voice"
  | "list-public-avatars"
  | "list-public-voices"
  | "list-video-agent-styles"
  | "scan-public-avatar-looks"
  | "scan-public-voices"
  | "submit-avatar-video"
  | "submit-video-agent";

function errorBody(message: string, code: string): HeyGenErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string): HeyGenErrorResponse {
  return { status: 400, body: errorBody(message, "BAD_REQUEST") };
}

function badGateway(message: string, code: string): HeyGenErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

function serviceUnavailable(
  message: string,
  code: string,
): HeyGenErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

export function isHeyGenErrorResponse(
  value: unknown,
): value is HeyGenErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalUrl(value: unknown): string | undefined {
  const candidate = optionalString(value);
  if (!candidate || !URL.canParse(candidate)) {
    return undefined;
  }
  const url = new URL(candidate);
  return url.protocol === "https:" || url.protocol === "http:"
    ? candidate
    : undefined;
}

function heyGenHeaders(
  apiKey: string,
  idempotencyKey: string | undefined,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) {
    return 1000;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 1000 : Math.max(0, timestamp - now());
}

async function requestHeyGen(
  options: HeyGenRequestOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<Response> {
  const request = () => {
    return fetch(options.url, {
      method: options.method,
      headers: heyGenHeaders(apiKey, options.idempotencyKey),
      ...(options.body ? { body: options.body } : {}),
      signal,
    });
  };
  const response = await request();
  if (response.status !== 429 || !options.retryRateLimit) {
    return response;
  }
  const retryAfterMs = retryAfterMilliseconds(
    response.headers.get("retry-after"),
  );
  if (retryAfterMs > HEYGEN_RATE_LIMIT_RETRY_MAX_MS) {
    return response;
  }
  await delay(retryAfterMs, { signal });
  return await request();
}

function providerErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) {
    return undefined;
  }
  return optionalString(value.error.message);
}

const PROVIDER_BODY_SNIPPET_MAX_LENGTH = 200;

/**
 * A gateway failure answers with its own error page instead of HeyGen's JSON
 * envelope, so `providerErrorMessage` finds nothing and every such event logs
 * the same unusable fallback. Keep a bounded, redacted slice of that body so
 * the error class stays distinguishable. Only a body that is not JSON at all
 * qualifies, which excludes any response shaped like a request echo.
 */
function providerBodySnippet(body: string): string | undefined {
  const collapsed = redactPresignedUrls(body).replace(/\s+/gu, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return collapsed.length > PROVIDER_BODY_SNIPPET_MAX_LENGTH
    ? `${collapsed.slice(0, PROVIDER_BODY_SNIPPET_MAX_LENGTH)}…`
    : collapsed;
}

interface HeyGenFailureContext {
  readonly operation: HeyGenOperation;
  readonly body: string;
  readonly parsed: unknown;
}

function heyGenProviderError(
  response: Response,
  context: HeyGenFailureContext,
): HeyGenErrorResponse {
  const rawMessage = providerErrorMessage(context.parsed);
  const providerMessage = rawMessage
    ? redactPresignedUrls(rawMessage)
    : "Unknown provider error";
  const providerBody =
    !rawMessage && context.parsed === undefined
      ? providerBodySnippet(context.body)
      : undefined;
  L.warn("HeyGen API request failed", {
    operation: context.operation,
    status: response.status,
    providerMessage,
    ...(providerBody === undefined ? {} : { providerBody }),
  });
  if (response.status === 400) {
    return badRequest(`HeyGen rejected the request: ${providerMessage}`);
  }
  if (response.status === 429) {
    return serviceUnavailable(
      "HeyGen is rate limited. Try again later.",
      "HEYGEN_RATE_LIMITED",
    );
  }
  if (response.status === 401 || response.status === 403) {
    return serviceUnavailable(
      "HeyGen is temporarily unavailable",
      "HEYGEN_UNAVAILABLE",
    );
  }
  if (response.status >= 500) {
    return serviceUnavailable(
      "HeyGen is temporarily unavailable",
      "HEYGEN_UNAVAILABLE",
    );
  }
  return badGateway(
    `HeyGen request failed: ${providerMessage}`,
    "HEYGEN_REQUEST_FAILED",
  );
}

async function readHeyGenResponse(
  response: Response,
  operation: HeyGenOperation,
): Promise<unknown | HeyGenErrorResponse> {
  const body = await response.text();
  const parsed = safeJsonParse(body);
  return response.ok
    ? parsed
    : heyGenProviderError(response, { operation, body, parsed });
}

function heyGenAspectRatio(
  aspectRatio: HeyGenAvatarVideoOptions["aspectRatio"],
): "16:9" | "9:16" | "1:1" {
  switch (aspectRatio) {
    case "landscape": {
      return "16:9";
    }
    case "portrait": {
      return "9:16";
    }
    case "square": {
      return "1:1";
    }
  }
}

function parseHeyGenVoice(value: unknown): HeyGenPublicVoice | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalString(value.voice_id)?.trim();
  const name = optionalString(value.name)?.trim();
  if (!id || !name) {
    return null;
  }
  const sampleUrl = optionalUrl(value.preview_audio_url);
  const language = optionalString(value.language)?.trim();
  const normalizedGender = optionalString(value.gender)?.toLowerCase();
  const gender =
    normalizedGender === "female" || normalizedGender === "male"
      ? normalizedGender
      : undefined;
  return {
    id,
    name,
    ...(sampleUrl ? { sampleUrl } : {}),
    ...(language ? { language } : {}),
    ...(gender ? { gender } : {}),
  };
}

function parseHeyGenGender(value: unknown): "female" | "male" | undefined {
  const normalized = optionalString(value)?.toLowerCase();
  return normalized === "female" || normalized === "male"
    ? normalized
    : undefined;
}

function parseHeyGenOrientation(
  value: unknown,
): "landscape" | "portrait" | "square" | undefined {
  const normalized = optionalString(value);
  return normalized === "landscape" ||
    normalized === "portrait" ||
    normalized === "square"
    ? normalized
    : undefined;
}

function parseHeyGenAvatarType(
  value: unknown,
): IntroVideoAvatarType | undefined {
  const parsed = introVideoAvatarTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

interface HeyGenAvatarIdentity {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly defaultVoiceId: string;
}

/** A public look is usable only when complete and renderable by Avatar III. */
function parseHeyGenAvatarIdentity(
  value: Record<string, unknown>,
): HeyGenAvatarIdentity | null {
  const id = optionalString(value.id)?.trim();
  const groupId = optionalString(value.group_id)?.trim();
  const name = optionalString(value.name)?.trim();
  const defaultVoiceId = optionalString(value.default_voice_id)?.trim();
  const engines = Array.isArray(value.supported_api_engines)
    ? value.supported_api_engines
    : [];
  if (
    !id ||
    !groupId ||
    !name ||
    !defaultVoiceId ||
    value.status !== "completed" ||
    !engines.includes("avatar_iii")
  ) {
    return null;
  }
  return { id, groupId, name, defaultVoiceId };
}

function parseHeyGenAvatar(value: unknown): HeyGenPublicAvatar | null {
  if (!isRecord(value)) {
    return null;
  }
  const identity = parseHeyGenAvatarIdentity(value);
  if (!identity) {
    return null;
  }
  const avatarType = parseHeyGenAvatarType(value.avatar_type);
  const previewImageUrl = optionalUrl(value.preview_image_url);
  const previewVideoUrl = optionalUrl(value.preview_video_url);
  const gender = parseHeyGenGender(value.gender);
  const imageWidth = parsePositiveInteger(value.image_width);
  const imageHeight = parsePositiveInteger(value.image_height);
  const preferredOrientation = parseHeyGenOrientation(
    value.preferred_orientation,
  );
  const parsed = introVideoAvatarSchema.safeParse({
    ...identity,
    ...(avatarType ? { avatarType } : {}),
    ...(previewImageUrl ? { previewImageUrl } : {}),
    ...(previewVideoUrl ? { previewVideoUrl } : {}),
    ...(gender ? { gender } : {}),
    ...(imageWidth ? { imageWidth } : {}),
    ...(imageHeight ? { imageHeight } : {}),
    ...(preferredOrientation ? { preferredOrientation } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function parseHeyGenStyle(value: unknown): HeyGenPublicStyle | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalString(value.style_id)?.trim();
  const name = optionalString(value.name)?.trim();
  if (!id || !name) {
    return null;
  }
  const thumbnailUrl = optionalUrl(value.thumbnail_url);
  const previewVideoUrl = optionalUrl(value.preview_video_url);
  const tags = Array.isArray(value.tags)
    ? value.tags.flatMap((tag) => {
        const parsed = optionalString(tag)?.trim();
        return parsed ? [parsed] : [];
      })
    : [];
  const rawAspectRatio = optionalString(value.aspect_ratio);
  const aspectRatio =
    rawAspectRatio === "16:9" ||
    rawAspectRatio === "9:16" ||
    rawAspectRatio === "1:1"
      ? rawAspectRatio
      : undefined;
  const parsed = introVideoStyleSchema.safeParse({
    id,
    name,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(previewVideoUrl ? { previewVideoUrl } : {}),
    tags,
    ...(aspectRatio ? { aspectRatio } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function parseHeyGenPage(value: unknown):
  | {
      readonly data: readonly unknown[];
      readonly hasMore: boolean;
      readonly nextToken: string | null;
    }
  | HeyGenErrorResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    typeof value.has_more !== "boolean"
  ) {
    return badGateway(
      "HeyGen returned an invalid catalog page",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const nextToken = optionalString(value.next_token) ?? null;
  if (value.has_more && !nextToken) {
    return badGateway(
      "HeyGen returned an incomplete catalog page",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  return { data: value.data, hasMore: value.has_more, nextToken };
}

interface HeyGenCatalogScan<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextToken: string | null;
}

/**
 * A filtered catalog can leave a provider page empty, and an empty page stalls
 * the picker's infinite scroll. Keep reading provider pages until one of them
 * survives filtering, the catalog ends, or this request's scan budget runs out.
 */
async function scanHeyGenCatalog<T>(
  token: string | undefined,
  fetchPage: (
    token: string | undefined,
  ) => Promise<HeyGenCatalogScan<T> | HeyGenErrorResponse>,
): Promise<HeyGenCatalogScan<T> | HeyGenErrorResponse> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let cursor = token;
  for (let scan = 0; scan < HEYGEN_CATALOG_SCAN_LIMIT; scan += 1) {
    const page = await fetchPage(cursor);
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    items.push(...page.items);
    const nextToken = page.hasMore ? page.nextToken : null;
    if (!nextToken) {
      return { items, hasMore: false, nextToken: null };
    }
    if (seenTokens.has(nextToken)) {
      return badGateway(
        "HeyGen returned a repeated catalog token",
        "HEYGEN_BAD_RESPONSE",
      );
    }
    seenTokens.add(nextToken);
    cursor = nextToken;
    if (items.length > 0) {
      return { items, hasMore: true, nextToken };
    }
  }
  return { items, hasMore: true, nextToken: cursor ?? null };
}

/** Reads one voice, keeping only what a user can audition first. */
async function getHeyGenSampledVoice(
  voiceId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicVoice | undefined | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "GET",
      url: `${HEYGEN_VOICES_URL}/${encodeURIComponent(voiceId)}`,
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  if (response.status === 404) {
    return undefined;
  }
  const body = await readHeyGenResponse(response, "get-voice");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  if (!isRecord(body)) {
    return badGateway(
      "HeyGen returned an invalid voice",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const voice = parseHeyGenVoice(body.data);
  return voice?.sampleUrl ? voice : undefined;
}

async function listHeyGenPublicAvatars(
  options: HeyGenAvatarCatalogOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicAvatarPage | HeyGenErrorResponse> {
  const url = new URL(HEYGEN_AVATAR_LOOKS_URL);
  url.searchParams.set("ownership", "public");
  url.searchParams.set("avatar_type", "studio_avatar");
  url.searchParams.set(
    "limit",
    String(Math.min(options.pageSize, HEYGEN_AVATAR_PAGE_SIZE)),
  );
  if (options.token) {
    url.searchParams.set("token", options.token);
  }
  if (options.groupId) {
    url.searchParams.set("group_id", options.groupId);
  }
  const response = await requestHeyGen(
    { method: "GET", url, retryRateLimit: true },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response, "list-public-avatars");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const page = parseHeyGenPage(body);
  if (isHeyGenErrorResponse(page)) {
    return page;
  }
  return {
    avatars: page.data.flatMap((value) => {
      const avatar = parseHeyGenAvatar(value);
      return avatar ? [avatar] : [];
    }),
    hasMore: page.hasMore,
    nextToken: page.nextToken,
  };
}

/**
 * Resolves each look's own voice so the picker can audition it. A look whose
 * voice carries no sample is dropped: the wizard only offers voices a user can
 * hear first. A provider failure stays a failure rather than an empty catalog.
 */
async function withHeyGenDefaultVoiceSamples(
  avatars: readonly HeyGenPublicAvatar[],
  apiKey: string,
  signal: AbortSignal,
): Promise<readonly HeyGenPublicAvatar[] | HeyGenErrorResponse> {
  const voiceIds = [
    ...new Set(
      avatars.map((avatar) => {
        return avatar.defaultVoiceId;
      }),
    ),
  ];
  const samples = new Map<string, HeyGenPublicVoice>();
  for (
    let offset = 0;
    offset < voiceIds.length;
    offset += HEYGEN_VOICE_LOOKUP_BATCH_SIZE
  ) {
    const resolved = await Promise.all(
      voiceIds
        .slice(offset, offset + HEYGEN_VOICE_LOOKUP_BATCH_SIZE)
        .map(async (voiceId) => {
          return [
            voiceId,
            await getHeyGenSampledVoice(voiceId, apiKey, signal),
          ] as const;
        }),
    );
    for (const [voiceId, voice] of resolved) {
      if (isHeyGenErrorResponse(voice)) {
        return voice;
      }
      if (voice) {
        samples.set(voiceId, voice);
      }
    }
  }
  return avatars.flatMap((avatar) => {
    const voice = samples.get(avatar.defaultVoiceId);
    return voice?.sampleUrl
      ? [
          {
            ...avatar,
            defaultVoiceName: voice.name,
            defaultVoiceSampleUrl: voice.sampleUrl,
          },
        ]
      : [];
  });
}

/**
 * The wizard's catalog: only looks whose own voice a user can audition first.
 * Avatar verification still reads the unfiltered catalog, because an already
 * selected look stays usable whether or not its voice offers a sample.
 */
export async function listHeyGenAvatarsWithVoiceSamples(
  options: HeyGenAvatarCatalogOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicAvatarPage | HeyGenErrorResponse> {
  const result = await scanHeyGenCatalog(options.token, async (token) => {
    const page = await listHeyGenPublicAvatars(
      { ...options, token },
      apiKey,
      signal,
    );
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    const avatars = await withHeyGenDefaultVoiceSamples(
      page.avatars,
      apiKey,
      signal,
    );
    return isHeyGenErrorResponse(avatars)
      ? avatars
      : { items: avatars, hasMore: page.hasMore, nextToken: page.nextToken };
  });
  return isHeyGenErrorResponse(result)
    ? result
    : {
        avatars: result.items,
        hasMore: result.hasMore,
        nextToken: result.nextToken,
      };
}

export async function listHeyGenPublicStyles(
  options: HeyGenStyleCatalogOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicStylePage | HeyGenErrorResponse> {
  const url = new URL(HEYGEN_VIDEO_AGENT_STYLES_URL);
  url.searchParams.set("limit", String(options.pageSize));
  if (options.token) {
    url.searchParams.set("token", options.token);
  }
  const response = await requestHeyGen(
    { method: "GET", url, retryRateLimit: true },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response, "list-video-agent-styles");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const page = parseHeyGenPage(body);
  if (isHeyGenErrorResponse(page)) {
    return page;
  }
  return {
    styles: page.data.flatMap((value) => {
      const style = parseHeyGenStyle(value);
      return style ? [style] : [];
    }),
    hasMore: page.hasMore,
    nextToken: page.nextToken,
  };
}

export async function verifyHeyGenPublicAvatar(
  avatarId: string,
  groupId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<boolean | HeyGenErrorResponse> {
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const page = await listHeyGenPublicAvatars(
      { groupId, token, pageSize: HEYGEN_AVATAR_PAGE_SIZE },
      apiKey,
      signal,
    );
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    if (
      page.avatars.some((avatar) => {
        return avatar.id === avatarId && avatar.groupId === groupId;
      })
    ) {
      return true;
    }
    const nextToken = page.hasMore ? (page.nextToken ?? undefined) : undefined;
    if (nextToken && seenTokens.has(nextToken)) {
      return badGateway(
        "HeyGen returned a repeated avatar catalog token",
        "HEYGEN_BAD_RESPONSE",
      );
    }
    if (nextToken) {
      seenTokens.add(nextToken);
    }
    token = nextToken;
  } while (token);
  return false;
}

export async function getHeyGenAvatarLook(
  avatarId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenAvatarLook | null | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "GET",
      url: `${HEYGEN_AVATAR_LOOKS_URL}/${encodeURIComponent(avatarId)}`,
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  if (response.status === 404) {
    return null;
  }
  const body = await readHeyGenResponse(response, "get-avatar-look");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const parsed = heyGenAvatarLookSchema.safeParse(body);
  if (!parsed.success || parsed.data.data.id !== avatarId) {
    return badGateway(
      "HeyGen returned an invalid avatar look",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const look = parsed.data.data;
  // Readiness is separate from ownership: a completed look still requires a
  // positive match in the public catalog before shared credentials can use it.
  if (look.status && look.status !== "completed") {
    return null;
  }
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const url = new URL(HEYGEN_AVATAR_LOOKS_URL);
    url.searchParams.set("ownership", "public");
    url.searchParams.set("limit", String(HEYGEN_AVATAR_PAGE_SIZE));
    if (look.group_id) {
      url.searchParams.set("group_id", look.group_id);
    }
    if (token) {
      url.searchParams.set("token", token);
    }
    const publicResponse = await requestHeyGen(
      { method: "GET", url, retryRateLimit: true },
      apiKey,
      signal,
    );
    const publicBody = await readHeyGenResponse(
      publicResponse,
      "scan-public-avatar-looks",
    );
    if (isHeyGenErrorResponse(publicBody)) {
      return publicBody;
    }
    const page = parseHeyGenPage(publicBody);
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    // Membership is independent of the Avatar III presenter engine. The
    // selected look's actual default voice still comes from its detail record.
    if (
      page.data.some((value) => {
        return (
          isRecord(value) &&
          optionalString(value.id)?.trim() === look.id &&
          (!look.group_id || value.group_id === look.group_id) &&
          (value.status === undefined ||
            value.status === null ||
            value.status === "completed")
        );
      })
    ) {
      return {
        id: look.id,
        groupId: look.group_id ?? null,
        defaultVoiceId: look.default_voice_id ?? null,
      };
    }
    const nextToken = page.hasMore ? (page.nextToken ?? undefined) : undefined;
    if (nextToken && seenTokens.has(nextToken)) {
      return badGateway(
        "HeyGen returned a repeated avatar catalog token",
        "HEYGEN_BAD_RESPONSE",
      );
    }
    if (nextToken) {
      seenTokens.add(nextToken);
    }
    token = nextToken;
  } while (token);
  return null;
}

export async function verifyHeyGenPublicStyle(
  styleId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<boolean | HeyGenErrorResponse> {
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const page = await listHeyGenPublicStyles(
      { token, pageSize: 100 },
      apiKey,
      signal,
    );
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    if (
      page.styles.some((style) => {
        return style.id === styleId;
      })
    ) {
      return true;
    }
    const nextToken = page.hasMore ? (page.nextToken ?? undefined) : undefined;
    if (nextToken && seenTokens.has(nextToken)) {
      return badGateway(
        "HeyGen returned a repeated style catalog token",
        "HEYGEN_BAD_RESPONSE",
      );
    }
    if (nextToken) {
      seenTokens.add(nextToken);
    }
    token = nextToken;
  } while (token);
  return false;
}

export async function verifyHeyGenVideoAgentVoice(
  voiceId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<boolean | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "GET",
      url: `${HEYGEN_VOICES_URL}/${encodeURIComponent(voiceId)}`,
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  if (response.status === 404) {
    return false;
  }
  const body = await readHeyGenResponse(response, "get-video-agent-voice");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const parsed = heyGenVideoAgentVoiceSchema.safeParse(body);
  if (!parsed.success || parsed.data.data.voice_id !== voiceId) {
    return badGateway(
      "HeyGen returned an invalid voice",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const voice = parsed.data.data;
  // Public catalog membership determines ownership independently of readiness.
  // Do not restrict a public avatar's default voice to the standalone TTS engine.
  if (!voice.name || (voice.status && voice.status !== "complete")) {
    return false;
  }
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const url = new URL(HEYGEN_VOICES_URL);
    url.searchParams.set("type", "public");
    url.searchParams.set("limit", "100");
    if (token) {
      url.searchParams.set("token", token);
    }
    const publicResponse = await requestHeyGen(
      { method: "GET", url, retryRateLimit: true },
      apiKey,
      signal,
    );
    const publicBody = await readHeyGenResponse(
      publicResponse,
      "scan-public-voices",
    );
    if (isHeyGenErrorResponse(publicBody)) {
      return publicBody;
    }
    const page = parseHeyGenPage(publicBody);
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    if (
      page.data.some((value) => {
        return (
          isRecord(value) &&
          value.type === "public" &&
          optionalString(value.voice_id)?.trim() === voiceId
        );
      })
    ) {
      return true;
    }
    const nextToken = page.hasMore ? (page.nextToken ?? undefined) : undefined;
    if (nextToken && seenTokens.has(nextToken)) {
      return badGateway(
        "HeyGen returned a repeated voice catalog token",
        "HEYGEN_BAD_RESPONSE",
      );
    }
    if (nextToken) {
      seenTokens.add(nextToken);
    }
    token = nextToken;
  } while (token);
  return false;
}

export async function verifyHeyGenPublicVoice(
  voiceId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<boolean | HeyGenErrorResponse> {
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const page = await listHeyGenPublicVoices(
      { token, pageSize: 100, language: undefined, gender: undefined },
      apiKey,
      signal,
    );
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    if (
      page.voices.some((voice) => {
        return voice.id === voiceId;
      })
    ) {
      return true;
    }
    const nextToken = page.hasMore ? (page.nextToken ?? undefined) : undefined;
    if (nextToken && seenTokens.has(nextToken)) {
      return badGateway(
        "HeyGen returned a repeated voice catalog token",
        "HEYGEN_BAD_RESPONSE",
      );
    }
    if (nextToken) {
      seenTokens.add(nextToken);
    }
    token = nextToken;
  } while (token);
  return false;
}

async function listHeyGenPublicVoices(
  options: HeyGenVoiceCatalogOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicVoicePage | HeyGenErrorResponse> {
  const url = new URL(HEYGEN_VOICES_URL);
  url.searchParams.set("type", "public");
  url.searchParams.set("engine", "starfish");
  url.searchParams.set("limit", String(options.pageSize));
  if (options.token) {
    url.searchParams.set("token", options.token);
  }
  if (options.language) {
    url.searchParams.set("language", options.language);
  }
  if (options.gender) {
    url.searchParams.set("gender", options.gender);
  }
  const response = await requestHeyGen(
    { method: "GET", url, retryRateLimit: true },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response, "list-public-voices");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  if (
    !isRecord(body) ||
    !Array.isArray(body.data) ||
    typeof body.has_more !== "boolean"
  ) {
    return badGateway(
      "HeyGen returned an invalid voice list",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const nextToken = optionalString(body.next_token) ?? null;
  if (body.has_more && !nextToken) {
    return badGateway(
      "HeyGen returned an incomplete voice page",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  return {
    voices: body.data.flatMap((value) => {
      const voice = parseHeyGenVoice(value);
      return voice ? [voice] : [];
    }),
    hasMore: body.has_more,
    nextToken,
  };
}

/**
 * HeyGen's default ranking front-loads hundreds of voices that carry no sample,
 * so the wizard's first pages would otherwise hold nothing a user can audition.
 * Scan with the provider's widest page to keep filling one request to a few
 * calls. Voice verification still reads the unfiltered catalog, because an
 * already selected voice stays usable whether or not it offers a sample.
 */
export async function listHeyGenPublicVoicesWithSamples(
  options: HeyGenVoiceCatalogOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicVoicePage | HeyGenErrorResponse> {
  const result = await scanHeyGenCatalog(options.token, async (token) => {
    const page = await listHeyGenPublicVoices(
      { ...options, token, pageSize: HEYGEN_VOICE_SCAN_PAGE_SIZE },
      apiKey,
      signal,
    );
    return isHeyGenErrorResponse(page)
      ? page
      : {
          items: page.voices.filter((voice) => {
            return voice.sampleUrl !== undefined;
          }),
          hasMore: page.hasMore,
          nextToken: page.nextToken,
        };
  });
  return isHeyGenErrorResponse(result)
    ? result
    : {
        voices: result.items,
        hasMore: result.hasMore,
        nextToken: result.nextToken,
      };
}

function heyGenSpeechContentType(
  response: Response,
  sourceUrl: string,
): "audio/mpeg" | "audio/wav" | null {
  const header = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    header === "audio/wav" ||
    header === "audio/wave" ||
    header === "audio/x-wav"
  ) {
    return "audio/wav";
  }
  if (header === "audio/mpeg" || header === "audio/mp3") {
    return "audio/mpeg";
  }
  if (!header || header === "application/octet-stream") {
    return new URL(sourceUrl).pathname.toLowerCase().endsWith(".wav")
      ? "audio/wav"
      : "audio/mpeg";
  }
  return null;
}

export async function generateHeyGenSpeech(
  options: HeyGenSpeechOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenGeneratedSpeech | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "POST",
      url: HEYGEN_VOICE_SPEECH_URL,
      body: JSON.stringify({
        text: options.text,
        voice_id: options.voiceId,
        input_type: "text",
        speed: 1,
      }),
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response, "generate-speech");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const sourceUrl = data ? optionalUrl(data.audio_url) : undefined;
  const durationSeconds = data ? optionalNumber(data.duration) : undefined;
  if (!sourceUrl || !durationSeconds || durationSeconds <= 0) {
    return badGateway(
      "HeyGen returned incomplete narration audio",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const audioResponse = await fetch(sourceUrl, { method: "GET", signal });
  if (!audioResponse.ok) {
    return badGateway(
      "Could not download the generated HeyGen narration",
      "AUDIO_DOWNLOAD_FAILED",
    );
  }
  const contentType = heyGenSpeechContentType(audioResponse, sourceUrl);
  if (!contentType) {
    return badGateway(
      "HeyGen returned an unsupported narration format",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const audioBytes = Buffer.from(await audioResponse.arrayBuffer());
  if (audioBytes.byteLength === 0) {
    return badGateway("HeyGen returned empty narration", "NO_AUDIO_RETURNED");
  }
  return {
    audioBytes,
    contentType,
    sourceUrl,
    providerRequestId: data ? optionalString(data.request_id) : undefined,
    durationSeconds,
  };
}

export async function submitHeyGenAvatarVideo(
  options: HeyGenAvatarVideoOptions,
  args: {
    readonly generationId: string;
    readonly callbackUrl: string;
  },
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenAvatarVideoHandle | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "POST",
      url: HEYGEN_VIDEOS_URL,
      body: JSON.stringify({
        type: "avatar",
        engine: { type: "avatar_iii" },
        avatar_id: options.avatarId,
        audio_url: options.audioUrl,
        aspect_ratio: heyGenAspectRatio(options.aspectRatio),
        resolution: "1080p",
        output_format: "webm",
        callback_url: args.callbackUrl,
        callback_id: args.generationId,
        ...(options.videoName ? { title: options.videoName } : {}),
      }),
      idempotencyKey: args.generationId,
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response, "submit-avatar-video");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const videoId = data ? optionalString(data.video_id) : undefined;
  if (!videoId) {
    return badGateway(
      "HeyGen returned no avatar video ID",
      "HEYGEN_NO_VIDEO_ID",
    );
  }
  return { videoId };
}

function parseHeyGenVideoAgentSession(
  body: unknown,
): HeyGenVideoAgentSession | HeyGenErrorResponse {
  const parsed = heyGenVideoAgentSessionSchema.safeParse(body);
  if (!parsed.success) {
    return badGateway(
      "HeyGen returned an invalid Video Agent session",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  return {
    sessionId: parsed.data.data.session_id,
    status: parsed.data.data.status,
    videoId: parsed.data.data.video_id ?? null,
  };
}

export function parseHeyGenVideoAgentCallback(
  value: unknown,
  generationId: string,
): {
  readonly sessionId: string | null;
  readonly videoId: string | null;
} | null {
  // Native event names and callback_id echoing are documented, but native
  // event_data fields are not guaranteed. These optional identity hints must
  // be verified through the provider API; callback output is never trusted.
  const parsed = heyGenVideoAgentCallbackSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const { callback_id: callbackId, event_data: data } = parsed.data;
  if (
    (callbackId && callbackId !== generationId) ||
    (data?.callback_id && data.callback_id !== generationId) ||
    (callbackId !== generationId && data?.callback_id !== generationId)
  ) {
    return null;
  }
  const sessionId = data?.session_id ?? null;
  const videoId = data?.video_id ?? null;
  return sessionId || videoId ? { sessionId, videoId } : null;
}

export async function submitHeyGenVideoAgent(
  options: HeyGenVideoAgentOptions,
  args: {
    readonly generationId: string;
    readonly callbackUrl: string;
  },
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenVideoAgentSession | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "POST",
      url: HEYGEN_VIDEO_AGENTS_URL,
      body: JSON.stringify({
        prompt: options.prompt,
        mode: "generate",
        // Platform credentials are shared; each brief must not read or write
        // provider account memory from another user or generation.
        incognito_mode: true,
        style_id: options.styleId,
        ...(options.avatarId ? { avatar_id: options.avatarId } : {}),
        ...(options.voiceId ? { voice_id: options.voiceId } : {}),
        orientation: options.orientation,
        files: options.fileUrls.map((url) => {
          return { type: "url", url };
        }),
        callback_url: args.callbackUrl,
        callback_id: args.generationId,
      }),
      // HeyGen does not document submission idempotency. Resume the durable
      // generation on ambiguous outcomes instead of issuing another paid POST.
      retryRateLimit: false,
    },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response, "submit-video-agent");
  return isHeyGenErrorResponse(body)
    ? body
    : parseHeyGenVideoAgentSession(body);
}

export async function getHeyGenVideoAgentSession(
  sessionId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenVideoAgentSession | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "GET",
      url: `${HEYGEN_VIDEO_AGENTS_URL}/${encodeURIComponent(sessionId)}`,
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response, "get-video-agent-session");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const session = parseHeyGenVideoAgentSession(body);
  if (isHeyGenErrorResponse(session)) {
    return session;
  }
  if (session.sessionId !== sessionId) {
    return badGateway(
      "HeyGen returned a different Video Agent session",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  return session;
}

export async function getHeyGenAvatarVideoStatus(
  videoId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenAvatarVideoStatus | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "GET",
      url: `${HEYGEN_VIDEOS_URL}/${encodeURIComponent(videoId)}`,
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response, "get-avatar-video-status");
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  if (!data || optionalString(data.id) !== videoId) {
    return badGateway(
      "HeyGen returned an invalid video response",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const status = optionalString(data.status)?.toLowerCase();
  if (
    status === "waiting" ||
    status === "pending" ||
    status === "processing" ||
    status === "rendering"
  ) {
    return { kind: "pending" };
  }
  if (status === "failed") {
    return {
      kind: "failed",
      message: redactPresignedUrls(
        optionalString(data.failure_message) ?? "Generation failed",
      ),
    };
  }
  if (status !== "completed") {
    return badGateway(
      "HeyGen returned an invalid video status",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const sourceUrl = optionalUrl(data.video_url);
  const durationSeconds = optionalNumber(data.duration);
  if (!sourceUrl || !durationSeconds || durationSeconds <= 0) {
    return badGateway(
      "HeyGen returned an incomplete completed video",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  return {
    kind: "completed",
    videoId,
    sourceUrl,
    durationSeconds,
  };
}

export async function downloadHeyGenAvatarVideo(
  status: Extract<HeyGenAvatarVideoStatus, { readonly kind: "completed" }>,
  signal: AbortSignal,
): Promise<HeyGenDownloadedAvatarVideo | HeyGenErrorResponse> {
  const response = await fetch(status.sourceUrl, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download the generated HeyGen avatar video",
      "VIDEO_DOWNLOAD_FAILED",
    );
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType && contentType !== "video/webm") {
    return badGateway(
      "HeyGen returned a non-WebM avatar video",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const videoBytes = Buffer.from(await response.arrayBuffer());
  if (videoBytes.byteLength === 0) {
    return badGateway("HeyGen returned an empty video", "NO_VIDEO_RETURNED");
  }
  return {
    videoBytes,
    contentType: "video/webm",
    sourceUrl: status.sourceUrl,
    providerVideoId: status.videoId,
    durationSeconds: status.durationSeconds,
  };
}

export async function downloadHeyGenVideoAgentVideo(
  status: Extract<HeyGenAvatarVideoStatus, { readonly kind: "completed" }>,
  signal: AbortSignal,
): Promise<
  | {
      readonly videoBytes: Buffer;
      readonly contentType: "video/mp4";
      readonly sourceUrl: string;
      readonly providerVideoId: string;
      readonly durationSeconds: number;
    }
  | HeyGenErrorResponse
> {
  const response = await fetch(status.sourceUrl, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download the generated HeyGen Video Agent video",
      "VIDEO_DOWNLOAD_FAILED",
    );
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "video/mp4") {
    return badGateway(
      "HeyGen returned a non-MP4 Video Agent video",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const videoBytes = Buffer.from(await response.arrayBuffer());
  if (videoBytes.byteLength === 0) {
    return badGateway("HeyGen returned an empty video", "NO_VIDEO_RETURNED");
  }
  return {
    videoBytes,
    contentType: "video/mp4",
    sourceUrl: status.sourceUrl,
    providerVideoId: status.videoId,
    durationSeconds: status.durationSeconds,
  };
}

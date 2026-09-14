import {
  socialKitRequestSchema,
  type ManagedSocialKitToolName,
  type SocialKitRequest,
} from "@okouai/api-contracts/contracts/social";
import { InvalidArgumentError } from "commander";

export const SOCIAL_PLATFORMS = [
  "linkedin",
  "twitter",
  "facebook",
  "instagram",
  "tiktok",
  "youtube",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type SocialOperation =
  | "comments"
  | "download"
  | "inspect"
  | "posts"
  | "search"
  | "summarize"
  | "transcript";

type SocialTargetKind =
  | "channel"
  | "company"
  | "playlist"
  | "post"
  | "profile"
  | "unknown"
  | "video";

export interface SocialUrlTarget {
  readonly kind: "url";
  readonly platform: SocialPlatform;
  readonly targetKind: SocialTargetKind;
  readonly input: string;
  readonly canonicalUrl: string;
}

export interface SocialQueryTarget {
  readonly kind: "query";
  readonly platform: SocialPlatform;
  readonly query: string;
}

export type SocialTarget = SocialQueryTarget | SocialUrlTarget;

export interface SocialRequestMetadata {
  readonly customPrompt?: boolean;
  readonly date?: string;
  readonly format?: string;
  readonly fullDetails?: boolean;
  readonly hashtag?: boolean;
  readonly kind?: string;
  readonly limit?: number;
  readonly maxDuration?: number;
  readonly quality?: string;
  readonly refresh?: boolean;
  readonly resume?: boolean;
  readonly sort?: string;
  readonly thread?: boolean;
  readonly type?: string;
}

export interface SocialIntent {
  readonly operation: SocialOperation;
  readonly platform: SocialPlatform;
  readonly target: SocialTarget;
  readonly requestMetadata: SocialRequestMetadata;
  readonly request: SocialKitRequest;
}

export interface SocialCapability {
  readonly platform: SocialPlatform;
  readonly operations: readonly SocialOperation[];
  readonly notes?: readonly string[];
}

export const SOCIAL_CAPABILITIES: readonly SocialCapability[] = [
  {
    platform: "linkedin",
    operations: ["inspect", "posts", "transcript"],
    notes: ["Inspect supports member profiles, companies, and posts"],
  },
  {
    platform: "twitter",
    operations: ["inspect", "posts", "transcript"],
    notes: ["Inspect supports profiles, posts, and threads"],
  },
  {
    platform: "facebook",
    operations: ["comments", "download", "inspect", "summarize", "transcript"],
  },
  {
    platform: "instagram",
    operations: [
      "comments",
      "download",
      "inspect",
      "posts",
      "search",
      "summarize",
      "transcript",
    ],
    notes: ["Posts supports posts and reels", "Search returns reels"],
  },
  {
    platform: "tiktok",
    operations: [
      "comments",
      "download",
      "inspect",
      "posts",
      "search",
      "summarize",
      "transcript",
    ],
    notes: ["Search supports keywords and hashtags"],
  },
  {
    platform: "youtube",
    operations: [
      "comments",
      "download",
      "inspect",
      "posts",
      "search",
      "summarize",
      "transcript",
    ],
    notes: [
      "Posts supports channels and playlists",
      "Posts --full-details requests exact dates and descriptions (slower; --limit at most 30)",
      "Unavailable publication dates and descriptions remain null, empty, or missing",
      "Transcript and summarize support --refresh to bypass extraction caches, including cached caption absence; captions may still be unavailable",
      "Summary-result caching is separate and unchanged by --refresh",
    ],
  },
] as const;

interface InspectOptions {
  readonly thread?: boolean;
}

interface PostsOptions {
  readonly fullDetails?: boolean;
  readonly kind?: string;
  readonly limit: number;
}

interface SearchOptions {
  readonly date?: string;
  readonly hashtag?: boolean;
  readonly limit: number;
  readonly platform: SocialPlatform;
  readonly sort?: string;
  readonly type?: string;
}

interface CommentsOptions {
  readonly limit: number;
  readonly sort?: string;
}

interface TranscriptOptions {
  readonly refresh?: boolean;
}

interface SummarizeOptions extends TranscriptOptions {
  readonly prompt?: string;
}

function socialRequest(
  tool: ManagedSocialKitToolName,
  input: Readonly<Record<string, unknown>>,
): SocialKitRequest {
  const parsed = socialKitRequestSchema.safeParse({ tool, input });
  if (!parsed.success) {
    throw new InvalidArgumentError(
      parsed.error.issues[0]?.message ?? "Okou Social input is invalid",
    );
  }
  return parsed.data;
}

function unsupported(message: string): never {
  throw new InvalidArgumentError(message);
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:m|mobile|music|www)\./u, "");
}

function platformForHostname(hostname: string): SocialPlatform | undefined {
  switch (normalizedHostname(hostname)) {
    case "linkedin.com": {
      return "linkedin";
    }
    case "twitter.com":
    case "x.com": {
      return "twitter";
    }
    case "facebook.com":
    case "fb.com":
    case "fb.watch": {
      return "facebook";
    }
    case "instagram.com": {
      return "instagram";
    }
    case "tiktok.com":
    case "vm.tiktok.com":
    case "vt.tiktok.com": {
      return "tiktok";
    }
    case "youtu.be":
    case "youtube.com": {
      return "youtube";
    }
    default: {
      return undefined;
    }
  }
}

function pathSegments(url: URL): readonly string[] {
  return url.pathname.split("/").filter(Boolean);
}

function linkedInTargetKind(url: URL): SocialTargetKind {
  const [first, second, third] = pathSegments(url);
  switch (first) {
    case "in": {
      return second ? "profile" : "unknown";
    }
    case "company": {
      return second ? "company" : "unknown";
    }
    case "posts":
    case "pulse": {
      return second ? "post" : "unknown";
    }
    case "feed": {
      return second === "update" && third ? "post" : "unknown";
    }
    default: {
      return "unknown";
    }
  }
}

const TWITTER_NON_PROFILE_PATHS = new Set([
  "compose",
  "explore",
  "home",
  "i",
  "messages",
  "notifications",
  "search",
  "settings",
]);

function twitterTargetKind(url: URL): SocialTargetKind {
  const segments = pathSegments(url);
  if (
    (segments[1] === "status" && segments[2]) ||
    (segments[0] === "i" &&
      segments[1] === "web" &&
      segments[2] === "status" &&
      segments[3])
  ) {
    return "post";
  }
  return segments.length === 1 &&
    segments[0] &&
    !TWITTER_NON_PROFILE_PATHS.has(segments[0])
    ? "profile"
    : "unknown";
}

const FACEBOOK_NON_CHANNEL_PATHS = new Set([
  "events",
  "gaming",
  "groups",
  "help",
  "login",
  "marketplace",
  "permalink.php",
  "photo",
  "photo.php",
  "photos",
  "posts",
  "reel",
  "reels",
  "share",
  "sharer",
  "story.php",
  "video.php",
  "videos",
  "watch",
]);

const FACEBOOK_STORY_QUERY_PATHS = new Set(["permalink.php", "story.php"]);
const FACEBOOK_PHOTO_QUERY_PATHS = new Set(["photo", "photo.php"]);

function hasQueryValue(url: URL, key: string): boolean {
  const value = url.searchParams.get(key);
  return value !== null && value.trim().length > 0;
}

function hasLegacyFacebookPostQuery(
  url: URL,
  segments: readonly string[],
): boolean {
  if (segments.length !== 1) {
    return false;
  }
  const [path] = segments;
  return (
    (path !== undefined &&
      FACEBOOK_STORY_QUERY_PATHS.has(path) &&
      hasQueryValue(url, "story_fbid")) ||
    (path !== undefined &&
      FACEBOOK_PHOTO_QUERY_PATHS.has(path) &&
      hasQueryValue(url, "fbid"))
  );
}

function shortVideoTargetKind(segments: readonly string[]): SocialTargetKind {
  return segments.length === 1 && segments[0] ? "video" : "unknown";
}

function facebookTargetKind(url: URL): SocialTargetKind {
  const hostname = normalizedHostname(url.hostname);
  const segments = pathSegments(url);
  if (hostname === "fb.watch") {
    return shortVideoTargetKind(segments);
  }
  const videoIndex = segments.findIndex((segment) => {
    return segment === "reel" || segment === "reels" || segment === "videos";
  });
  const watchIndex = segments.indexOf("watch");
  const legacyVideoQuery =
    segments.length === 1 &&
    (segments[0] === "watch" || segments[0] === "video.php") &&
    hasQueryValue(url, "v");
  if (
    (videoIndex >= 0 && segments[videoIndex + 1]) ||
    (watchIndex >= 0 && segments[watchIndex + 1]) ||
    legacyVideoQuery
  ) {
    return "video";
  }
  const postIndex = segments.findIndex((segment) => {
    return segment === "posts" || segment === "photos";
  });
  if (
    (postIndex >= 0 && segments[postIndex + 1]) ||
    hasLegacyFacebookPostQuery(url, segments)
  ) {
    return "post";
  }
  if (segments[0] === "profile.php") {
    return segments.length === 1 && hasQueryValue(url, "id")
      ? "channel"
      : "unknown";
  }
  return segments.length === 1 &&
    segments[0] &&
    !FACEBOOK_NON_CHANNEL_PATHS.has(segments[0])
    ? "channel"
    : "unknown";
}

const INSTAGRAM_NON_PROFILE_PATHS = new Set([
  "about",
  "accounts",
  "api",
  "challenge",
  "developer",
  "direct",
  "directory",
  "explore",
  "legal",
  "privacy",
  "stories",
]);

function instagramTargetKind(url: URL): SocialTargetKind {
  const segments = pathSegments(url);
  const [first, second] = segments;
  if (first === "p") {
    return second ? "post" : "unknown";
  }
  if (first === "reel" || first === "reels" || first === "tv") {
    return second ? "video" : "unknown";
  }
  return segments.length === 1 &&
    first &&
    !INSTAGRAM_NON_PROFILE_PATHS.has(first)
    ? "profile"
    : "unknown";
}

function tiktokTargetKind(url: URL): SocialTargetKind {
  const hostname = normalizedHostname(url.hostname);
  const segments = pathSegments(url);
  if (hostname === "vm.tiktok.com" || hostname === "vt.tiktok.com") {
    return shortVideoTargetKind(segments);
  }
  if (segments[0]?.startsWith("@") && segments[1] === "video" && segments[2]) {
    return "video";
  }
  if (segments.length === 2 && segments[0] === "t" && segments[1]) {
    return "video";
  }
  return segments.length === 1 &&
    segments[0]?.startsWith("@") &&
    segments[0].length > 1
    ? "profile"
    : "unknown";
}

const YOUTUBE_VIDEO_PATHS = new Set(["live", "shorts"]);
const YOUTUBE_CHANNEL_PATHS = new Set(["c", "channel", "user"]);

function youtubeTargetKind(url: URL): SocialTargetKind {
  const hostname = normalizedHostname(url.hostname);
  const segments = pathSegments(url);
  if (hostname === "youtu.be") {
    return segments.length === 1 && segments[0] ? "video" : "unknown";
  }
  if (
    segments.length === 1 &&
    segments[0] === "watch" &&
    hasQueryValue(url, "v")
  ) {
    return "video";
  }
  if (
    segments.length === 2 &&
    segments[0] &&
    YOUTUBE_VIDEO_PATHS.has(segments[0]) &&
    segments[1]
  ) {
    return "video";
  }
  if (
    segments.length === 1 &&
    segments[0] === "playlist" &&
    hasQueryValue(url, "list")
  ) {
    return "playlist";
  }
  if (segments[0]?.startsWith("@") && segments[0].length > 1) {
    return "channel";
  }
  if (segments[0] && YOUTUBE_CHANNEL_PATHS.has(segments[0]) && segments[1]) {
    return "channel";
  }
  return "unknown";
}

function targetKind(platform: SocialPlatform, url: URL): SocialTargetKind {
  switch (platform) {
    case "linkedin": {
      return linkedInTargetKind(url);
    }
    case "twitter": {
      return twitterTargetKind(url);
    }
    case "facebook": {
      return facebookTargetKind(url);
    }
    case "instagram": {
      return instagramTargetKind(url);
    }
    case "tiktok": {
      return tiktokTargetKind(url);
    }
    case "youtube": {
      return youtubeTargetKind(url);
    }
  }
}

function canonicalHostname(platform: SocialPlatform, hostname: string): string {
  const normalized = normalizedHostname(hostname);
  switch (platform) {
    case "linkedin": {
      return "www.linkedin.com";
    }
    case "twitter": {
      return "x.com";
    }
    case "facebook": {
      return normalized === "fb.watch" ? normalized : "www.facebook.com";
    }
    case "instagram": {
      return "www.instagram.com";
    }
    case "tiktok": {
      return normalized === "tiktok.com" ? "www.tiktok.com" : normalized;
    }
    case "youtube": {
      return normalized === "youtu.be" ? normalized : "www.youtube.com";
    }
  }
}

const TRACKING_QUERY_PARAMETERS = new Set([
  "_r",
  "_t",
  "fbclid",
  "igshid",
  "si",
]);

function canonicalizeUrl(url: URL, platform: SocialPlatform): string {
  url.protocol = "https:";
  url.hostname = canonicalHostname(platform, url.hostname);
  url.port = "";
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (key.startsWith("utm_") || TRACKING_QUERY_PARAMETERS.has(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

export function parseSocialTarget(input: string): SocialUrlTarget {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidArgumentError("target must be a valid social URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new InvalidArgumentError(
      "target must be an HTTP(S) URL without embedded credentials",
    );
  }
  const platform = platformForHostname(url.hostname);
  if (!platform) {
    throw new InvalidArgumentError(
      "unsupported social host; use LinkedIn, X, Facebook, Instagram, TikTok, or YouTube",
    );
  }
  return {
    kind: "url",
    platform,
    targetKind: targetKind(platform, url),
    input,
    canonicalUrl: canonicalizeUrl(url, platform),
  };
}

export function parseSocialPlatform(value: string): SocialPlatform {
  const lower = value.toLowerCase();
  const normalized = lower === "x" ? "twitter" : lower;
  const platform = SOCIAL_PLATFORMS.find((candidate) => {
    return candidate === normalized;
  });
  if (!platform) {
    throw new InvalidArgumentError(
      "platform must be linkedin, twitter, facebook, instagram, tiktok, or youtube",
    );
  }
  return platform;
}

function urlIntent(
  operation: SocialOperation,
  target: SocialUrlTarget,
  tool: ManagedSocialKitToolName,
  input: Readonly<Record<string, unknown>>,
  requestMetadata: SocialRequestMetadata,
): SocialIntent {
  return {
    operation,
    platform: target.platform,
    target,
    requestMetadata,
    request: socialRequest(tool, input),
  };
}

function contentTarget(target: SocialUrlTarget, operation: string): void {
  if (target.targetKind !== "post" && target.targetKind !== "video") {
    unsupported(`${operation} requires a public post or video URL`);
  }
}

function linkedInInspectionTool(
  targetKind: SocialTargetKind,
): ManagedSocialKitToolName {
  switch (targetKind) {
    case "company": {
      return "linkedin_company";
    }
    case "post": {
      return "linkedin_post";
    }
    case "profile": {
      return "linkedin_profile";
    }
    default: {
      return unsupported(
        "cannot infer a LinkedIn profile, company, or post from this URL",
      );
    }
  }
}

function twitterInspectionTool(
  targetKind: SocialTargetKind,
  thread: boolean,
): ManagedSocialKitToolName {
  if (targetKind === "profile") {
    return thread
      ? unsupported("--thread requires an X post URL")
      : "twitter_profile";
  }
  if (targetKind === "post") {
    return thread ? "twitter_thread" : "twitter_tweet";
  }
  return unsupported("cannot infer an X profile or post from this URL");
}

function channelOrContentInspectionTool(
  target: SocialUrlTarget,
  channelKind: SocialTargetKind,
  channelTool: ManagedSocialKitToolName,
  contentTool: ManagedSocialKitToolName,
  invalidTargetMessage: string,
): ManagedSocialKitToolName {
  if (target.targetKind === "unknown") {
    return unsupported(invalidTargetMessage);
  }
  return target.targetKind === channelKind ? channelTool : contentTool;
}

function inspectionTool(
  target: SocialUrlTarget,
  thread: boolean,
): ManagedSocialKitToolName {
  switch (target.platform) {
    case "linkedin": {
      return linkedInInspectionTool(target.targetKind);
    }
    case "twitter": {
      return twitterInspectionTool(target.targetKind, thread);
    }
    case "facebook": {
      return channelOrContentInspectionTool(
        target,
        "channel",
        "facebook_channel_stats",
        "facebook_stats",
        "cannot infer a Facebook page or post from this URL",
      );
    }
    case "instagram": {
      return channelOrContentInspectionTool(
        target,
        "profile",
        "instagram_channel_stats",
        "instagram_stats",
        "cannot infer an Instagram profile or post from this URL",
      );
    }
    case "tiktok": {
      return channelOrContentInspectionTool(
        target,
        "profile",
        "tiktok_channel_stats",
        "tiktok_stats",
        "cannot infer a TikTok profile or video from this URL",
      );
    }
    case "youtube": {
      if (target.targetKind === "playlist") {
        return unsupported(
          "inspect does not support YouTube playlist URLs; use posts",
        );
      }
      return channelOrContentInspectionTool(
        target,
        "channel",
        "youtube_channel_stats",
        "youtube_stats",
        "cannot infer a YouTube channel or video from this URL",
      );
    }
  }
}

export function inspectIntent(
  target: SocialUrlTarget,
  options: InspectOptions,
): SocialIntent {
  if (options.thread && target.platform !== "twitter") {
    return unsupported("--thread is supported only for X post URLs");
  }
  return urlIntent(
    "inspect",
    target,
    inspectionTool(target, options.thread === true),
    { url: target.canonicalUrl },
    { thread: options.thread === true },
  );
}

function youtubePostsIntent(
  target: SocialUrlTarget,
  options: PostsOptions,
): SocialIntent {
  if (target.targetKind !== "channel" && target.targetKind !== "playlist") {
    return unsupported("YouTube posts requires a channel or playlist URL");
  }
  if (options.fullDetails === true && options.limit > 30) {
    return unsupported(
      "--full-details supports at most 30 videos; use --limit 30 or less, or omit --full-details for the fast listing",
    );
  }
  return urlIntent(
    "posts",
    target,
    "youtube_videos",
    {
      url: target.canonicalUrl,
      limit: Math.min(options.limit, 100),
      ...(options.fullDetails === true ? { full_details: true } : {}),
    },
    {
      limit: options.limit,
      ...(options.fullDetails === true ? { fullDetails: true } : {}),
    },
  );
}

export function postsIntent(
  target: SocialUrlTarget,
  options: PostsOptions,
): SocialIntent {
  if (options.fullDetails === true && target.platform !== "youtube") {
    return unsupported(
      "--full-details is supported only for YouTube channels and playlists",
    );
  }
  if (options.kind !== undefined && target.platform !== "instagram") {
    return unsupported("--kind is supported only for Instagram profiles");
  }
  const requestMetadata: SocialRequestMetadata = {
    limit: options.limit,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  };
  switch (target.platform) {
    case "linkedin": {
      if (target.targetKind !== "company") {
        return unsupported("LinkedIn posts requires a company URL");
      }
      return urlIntent(
        "posts",
        target,
        "linkedin_company_posts",
        {
          url: target.canonicalUrl,
          limit: Math.min(options.limit, 50),
        },
        requestMetadata,
      );
    }
    case "twitter": {
      if (target.targetKind !== "profile") {
        return unsupported("X posts requires a profile URL");
      }
      return urlIntent(
        "posts",
        target,
        "twitter_tweets",
        {
          url: target.canonicalUrl,
          limit: Math.min(options.limit, 100),
        },
        requestMetadata,
      );
    }
    case "facebook": {
      return unsupported("Facebook profile posts are not currently supported");
    }
    case "instagram": {
      if (target.targetKind !== "profile") {
        return unsupported("Instagram posts requires a profile URL");
      }
      if (
        options.kind !== undefined &&
        options.kind !== "posts" &&
        options.kind !== "reels"
      ) {
        return unsupported("Instagram --kind must be posts or reels");
      }
      return urlIntent(
        "posts",
        target,
        options.kind === "reels"
          ? "instagram_channel_reels"
          : "instagram_channel_posts",
        { url: target.canonicalUrl, limit: Math.min(options.limit, 100) },
        requestMetadata,
      );
    }
    case "tiktok": {
      if (target.targetKind !== "profile") {
        return unsupported("TikTok posts requires a profile URL");
      }
      return urlIntent(
        "posts",
        target,
        "tiktok_channel_videos",
        {
          url: target.canonicalUrl,
          limit: Math.min(options.limit, 100),
        },
        requestMetadata,
      );
    }
    case "youtube": {
      return youtubePostsIntent(target, options);
    }
  }
}

interface SearchRequest {
  readonly tool: ManagedSocialKitToolName;
  readonly input: Readonly<Record<string, unknown>>;
}

function instagramSearchRequest(
  query: string,
  options: SearchOptions,
): SearchRequest {
  if (
    options.hashtag ||
    options.sort !== undefined ||
    options.date !== undefined ||
    options.type !== undefined
  ) {
    return unsupported(
      "Instagram search does not support hashtag, sort, date, or type filters",
    );
  }
  return { tool: "instagram_reels_search", input: { query } };
}

function tiktokSearchRequest(
  query: string,
  options: SearchOptions,
): SearchRequest {
  if (options.type !== undefined) {
    return unsupported("TikTok search does not support --type");
  }
  if (options.hashtag) {
    if (options.sort !== undefined || options.date !== undefined) {
      return unsupported(
        "TikTok hashtag search does not support sort or date filters",
      );
    }
    const hashtag = query.replace(/^#/u, "");
    if (!hashtag) {
      return unsupported("TikTok hashtag must not be empty");
    }
    return {
      tool: "tiktok_hashtag_search",
      input: {
        hashtag,
        limit: Math.min(options.limit, 100),
      },
    };
  }
  return {
    tool: "tiktok_search",
    input: {
      query,
      limit: Math.min(options.limit, 100),
      ...(options.sort === undefined ? {} : { sortBy: options.sort }),
      ...(options.date === undefined ? {} : { datePosted: options.date }),
    },
  };
}

function youtubeSearchRequest(
  query: string,
  options: SearchOptions,
): SearchRequest {
  if (options.hashtag) {
    return unsupported("YouTube search does not support --hashtag");
  }
  return {
    tool: "youtube_search",
    input: {
      query,
      limit: Math.min(options.limit, 100),
      ...(options.sort === undefined ? {} : { sortBy: options.sort }),
      ...(options.date === undefined ? {} : { uploadDate: options.date }),
      ...(options.type === undefined ? {} : { type: options.type }),
    },
  };
}

function searchRequest(query: string, options: SearchOptions): SearchRequest {
  switch (options.platform) {
    case "instagram": {
      return instagramSearchRequest(query, options);
    }
    case "tiktok": {
      return tiktokSearchRequest(query, options);
    }
    case "youtube": {
      return youtubeSearchRequest(query, options);
    }
    case "facebook":
    case "linkedin":
    case "twitter": {
      return unsupported(
        `${options.platform} search is not currently supported`,
      );
    }
  }
}

export function searchIntent(
  query: string,
  options: SearchOptions,
): SocialIntent {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new InvalidArgumentError("query must not be empty");
  }
  const target: SocialQueryTarget = {
    kind: "query",
    platform: options.platform,
    query: normalizedQuery,
  };
  const request = searchRequest(normalizedQuery, options);
  return {
    operation: "search",
    platform: options.platform,
    target,
    requestMetadata: {
      limit: options.limit,
      hashtag: options.hashtag === true,
      ...(options.sort === undefined ? {} : { sort: options.sort }),
      ...(options.date === undefined ? {} : { date: options.date }),
      ...(options.type === undefined ? {} : { type: options.type }),
    },
    request: socialRequest(request.tool, request.input),
  };
}

export function commentsIntent(
  target: SocialUrlTarget,
  options: CommentsOptions,
): SocialIntent {
  contentTarget(target, "comments");
  const requestMetadata: SocialRequestMetadata = {
    limit: options.limit,
    ...(options.sort === undefined ? {} : { sort: options.sort }),
  };
  const base = {
    url: target.canonicalUrl,
    limit: Math.min(options.limit, 100),
  };
  switch (target.platform) {
    case "facebook": {
      if (options.sort !== undefined) {
        return unsupported("Facebook comments does not support --sort");
      }
      return urlIntent(
        "comments",
        target,
        "facebook_comments",
        base,
        requestMetadata,
      );
    }
    case "instagram": {
      return urlIntent(
        "comments",
        target,
        "instagram_comments",
        {
          ...base,
          ...(options.sort === undefined ? {} : { sortBy: options.sort }),
        },
        requestMetadata,
      );
    }
    case "tiktok": {
      if (options.sort !== undefined) {
        return unsupported("TikTok comments does not support --sort");
      }
      return urlIntent(
        "comments",
        target,
        "tiktok_comments",
        base,
        requestMetadata,
      );
    }
    case "youtube": {
      return urlIntent(
        "comments",
        target,
        "youtube_comments",
        {
          ...base,
          ...(options.sort === undefined ? {} : { sortBy: options.sort }),
        },
        requestMetadata,
      );
    }
    case "linkedin":
    case "twitter": {
      return unsupported(
        `${target.platform} comments are not currently supported`,
      );
    }
  }
}

export function transcriptIntent(
  target: SocialUrlTarget,
  options: TranscriptOptions,
): SocialIntent {
  contentTarget(target, "transcript");
  if (options.refresh && target.platform !== "youtube") {
    return unsupported("--refresh is supported only for YouTube videos");
  }
  let tool: ManagedSocialKitToolName;
  switch (target.platform) {
    case "linkedin": {
      tool = "linkedin_transcript";
      break;
    }
    case "twitter": {
      tool = "twitter_transcript";
      break;
    }
    case "facebook": {
      tool = "facebook_transcript";
      break;
    }
    case "instagram": {
      tool = "instagram_transcript";
      break;
    }
    case "tiktok": {
      tool = "tiktok_transcript";
      break;
    }
    case "youtube": {
      tool = "youtube_transcript";
      break;
    }
  }
  return urlIntent(
    "transcript",
    target,
    tool,
    {
      url: target.canonicalUrl,
      ...(options.refresh ? { no_cache: true } : {}),
    },
    options.refresh ? { refresh: true } : {},
  );
}

export function summarizeIntent(
  target: SocialUrlTarget,
  options: SummarizeOptions,
): SocialIntent {
  contentTarget(target, "summarize");
  if (options.refresh && target.platform !== "youtube") {
    return unsupported("--refresh is supported only for YouTube videos");
  }
  if (target.platform === "linkedin" || target.platform === "twitter") {
    return unsupported(
      `${target.platform} summaries are not currently supported`,
    );
  }
  let tool: ManagedSocialKitToolName;
  switch (target.platform) {
    case "facebook": {
      tool = "facebook_summarize";
      break;
    }
    case "instagram": {
      tool = "instagram_summarize";
      break;
    }
    case "tiktok": {
      tool = "tiktok_summarize";
      break;
    }
    case "youtube": {
      tool = "youtube_summarize";
      break;
    }
  }
  return urlIntent(
    "summarize",
    target,
    tool,
    {
      url: target.canonicalUrl,
      ...(options.prompt === undefined
        ? {}
        : { custom_prompt: options.prompt }),
      ...(options.refresh ? { no_cache: true } : {}),
    },
    {
      customPrompt: options.prompt !== undefined,
      ...(options.refresh ? { refresh: true } : {}),
    },
  );
}

export function downloadPlatform(
  target: SocialUrlTarget,
): "facebook" | "instagram" | "tiktok" | "youtube" {
  contentTarget(target, "download");
  switch (target.platform) {
    case "facebook":
    case "instagram":
    case "tiktok":
    case "youtube": {
      return target.platform;
    }
    case "linkedin":
    case "twitter": {
      return unsupported(
        `${target.platform} downloads are not currently supported`,
      );
    }
  }
}

import {
  socialDataRequestSchema,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";

export class SocialDataProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 422 | 429 | 502 | 503 = 502,
  ) {
    super(message);
    this.name = "SocialDataProviderError";
  }
}

export type SocialDataProviderInput = {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly queryParams?: Readonly<Record<string, unknown>>;
};

export interface SocialDataProviderPlan {
  readonly request: SocialDataRequest;
  /** Apify runs Actors; TikHub proxies vendor APIs with per-call pricing. */
  readonly provider: "apify" | "tikhub";
  readonly endpoint: string;
  readonly input: SocialDataProviderInput;
  readonly maxBillableUnits: number;
  readonly format:
    | "instagram-user"
    | "instagram-post"
    | "instagram-comment"
    | "tiktok-post"
    | "tiktok-comment"
    | "youtube-post"
    | "youtube-comment"
    | "youtube-transcript"
    | "facebook-page"
    | "facebook-post"
    | "facebook-comment"
    | "x-post"
    | "xiaohongshu-user"
    | "xiaohongshu-note"
    | "xiaohongshu-comment";
}

/** Recent posts and Reels carried by one Instagram profile lookup. */
const INSTAGRAM_PROFILE_FEED = 12;

function unsupported(message: string): never {
  throw new SocialDataProviderError("SOCIAL_DATA_UNSUPPORTED", message, 422);
}

function rejectOptions(
  request: SocialDataRequest,
  accepted: readonly (keyof SocialDataRequest)[] = [],
) {
  const allowed: ReadonlySet<string> = new Set([
    "operation",
    "platform",
    "url",
    "query",
    "limit",
    ...accepted,
  ]);
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined && !allowed.has(key)) {
      unsupported(`The ${key} option is unavailable for this operation.`);
    }
  }
}

function choice(value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) {
    unsupported(`Use one of these option values: ${allowed.join(", ")}.`);
  }
  return value;
}

function plan(
  request: SocialDataRequest,
  endpoint: string,
  body: Readonly<Record<string, unknown>>,
  format: SocialDataProviderPlan["format"],
  maxBillableUnits = request.limit,
): SocialDataProviderPlan {
  return {
    request,
    provider: "apify",
    endpoint,
    input: { body },
    format,
    maxBillableUnits,
  };
}

/**
 * TikHub endpoints are priced per call and take query parameters, so the
 * billable unit is always one regardless of how many rows come back.
 */
function queryPlan(
  request: SocialDataRequest,
  endpoint: string,
  queryParams: Readonly<Record<string, unknown>>,
  format: SocialDataProviderPlan["format"],
): SocialDataProviderPlan {
  return {
    request,
    provider: "tikhub",
    endpoint,
    input: { queryParams },
    format,
    maxBillableUnits: 1,
  };
}

function targetUrl(request: SocialDataRequest): URL {
  if (!request.url) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_INVALID_INPUT",
      "A URL is required.",
      400,
    );
  }
  const url = new URL(request.url);
  const host = url.hostname;
  const hosts: Record<SocialDataRequest["platform"], readonly string[]> = {
    instagram: ["instagram.com", "www.instagram.com"],
    tiktok: ["tiktok.com", "www.tiktok.com"],
    youtube: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"],
    facebook: ["facebook.com", "www.facebook.com", "m.facebook.com"],
    x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    xiaohongshu: [
      "xiaohongshu.com",
      "www.xiaohongshu.com",
      "xhslink.com",
      "xhslink.cn",
    ],
  };
  if (!hosts[request.platform].includes(host) || url.hash) {
    unsupported("Use a full public URL belonging to the selected platform.");
  }
  return url;
}

function instagramPlan(request: SocialDataRequest): SocialDataProviderPlan {
  if (request.operation === "search" || request.operation === "transcript") {
    unsupported("This Instagram operation is unavailable for data jobs.");
  }
  const url = targetUrl(request);
  const isPost = /^\/(?:p|reel)\/[\w-]+\/?$/.test(url.pathname);
  const profile = /^\/([\w.]+)\/?$/.exec(url.pathname)?.[1];
  if (!isPost && !profile) {
    unsupported("Use an Instagram profile, post, or Reel URL.");
  }
  if (profile) {
    if (request.operation === "comments") {
      unsupported("Comments require an Instagram post or Reel URL.");
    }
    rejectOptions(request, request.operation === "posts" ? ["kind"] : []);
    if (request.operation === "posts" && request.limit > INSTAGRAM_PROFILE_FEED) {
      unsupported(
        `Instagram data jobs return at most ${INSTAGRAM_PROFILE_FEED} recent items per profile request.`,
      );
    }
    // One call carries the profile plus its recent posts and Reels, so
    // inspect and posts share it instead of paying for a second lookup.
    return queryPlan(
      request,
      "/api/v1/instagram/v1/fetch_user_info_by_username",
      { username: profile },
      "instagram-user",
    );
  }
  if (request.operation === "comments") {
    rejectOptions(request, ["sort"]);
    return queryPlan(
      request,
      "/api/v1/instagram/v2/fetch_post_comments",
      {
        code_or_url: url.href,
        sort_by:
          request.sort && choice(request.sort, ["recent", "popular"]) === "popular"
            ? "popular"
            : "recent",
      },
      "instagram-comment",
    );
  }
  rejectOptions(request);
  return queryPlan(
    request,
    "/api/v1/instagram/v1/fetch_post_by_url",
    { post_url: url.href },
    "instagram-post",
  );
}

function xiaohongshuPlan(request: SocialDataRequest): SocialDataProviderPlan {
  if (request.operation === "transcript") {
    unsupported("Xiaohongshu data jobs do not provide transcripts.");
  }
  if (request.operation === "search") {
    rejectOptions(request, ["sort", "kind"]);
    if (/[\r\n]/.test(request.query ?? "")) {
      unsupported("Xiaohongshu search accepts one query on a single line.");
    }
    return queryPlan(
      request,
      "/api/v1/xiaohongshu/app_v2/search_notes",
      {
        keyword: request.query,
        page: 1,
        sort_type: request.sort
          ? choice(request.sort, ["general", "popularity_descending", "time_descending"])
          : "general",
        note_type: request.kind === "reels" ? "视频笔记" : "不限",
      },
      "xiaohongshu-note",
    );
  }
  const url = targetUrl(request);
  rejectOptions(request);
  // Share links resolve upstream, so they are forwarded untouched.
  const share = url.hostname.endsWith("xhslink.com") || url.hostname.endsWith("xhslink.cn");
  const userId = /^\/user\/profile\/([0-9a-f]{24})\/?$/.exec(url.pathname)?.[1];
  const noteId = /^\/(?:explore|discovery\/item)\/([0-9a-f]{24})\/?$/.exec(
    url.pathname,
  )?.[1];
  if (!share && !userId && !noteId) {
    unsupported(
      "Use a Xiaohongshu profile URL, note URL, or an xhslink share link.",
    );
  }
  const target = share
    ? { share_text: url.href }
    : userId
      ? { user_id: userId }
      : { note_id: noteId };
  if (request.operation === "posts") {
    if (noteId) {
      unsupported("Posts require a Xiaohongshu profile URL.");
    }
    return queryPlan(
      request,
      "/api/v1/xiaohongshu/app_v2/get_user_posted_notes",
      target,
      "xiaohongshu-note",
    );
  }
  if (request.operation === "comments") {
    if (userId) {
      unsupported("Comments require a Xiaohongshu note URL.");
    }
    return queryPlan(
      request,
      "/api/v1/xiaohongshu/app_v2/get_note_comments",
      { ...target, sort_strategy: "like_count" },
      "xiaohongshu-comment",
    );
  }
  if (userId) {
    return queryPlan(
      request,
      "/api/v1/xiaohongshu/app_v2/get_user_info",
      target,
      "xiaohongshu-user",
    );
  }
  // The image endpoint returns both image and video notes.
  return queryPlan(
    request,
    "/api/v1/xiaohongshu/app_v2/get_image_note_detail",
    target,
    "xiaohongshu-note",
  );
}

function tiktokPlan(request: SocialDataRequest): SocialDataProviderPlan {
  if (request.operation === "search") {
    rejectOptions(request);
    return plan(
      request,
      "/apidojo/tiktok-scraper",
      { keywords: [request.query], maxItems: request.limit },
      "tiktok-post",
    );
  }
  const url = targetUrl(request);
  const profile = /^\/@[\w.]+\/?$/.test(url.pathname);
  const contentId = /^\/@[\w.]+\/(?:video|photo)\/(\d+)\/?$/.exec(
    url.pathname,
  )?.[1];
  rejectOptions(request);
  if (request.operation === "posts" && profile) {
    return plan(
      request,
      "/apidojo/tiktok-profile-scraper",
      { startUrls: [url.href], maxItems: request.limit },
      "tiktok-post",
    );
  }
  if (request.operation === "inspect" && contentId) {
    return plan(
      request,
      "/apidojo/tiktok-scraper",
      { startUrls: [url.href], maxItems: 1 },
      "tiktok-post",
      1,
    );
  }
  if (request.operation === "comments" && contentId) {
    return plan(
      request,
      "/scraptik/tiktok-comments-scraper-api",
      {
        listComments_awemeId: contentId,
        listComments_count: request.limit,
        listComments_cursor: 0,
      },
      "tiktok-comment",
    );
  }
  return unsupported(
    "TikTok data jobs support profile posts, video details, search, and one batch of video comments.",
  );
}

function youtubeContent(url: URL): boolean {
  if (url.hostname === "youtu.be") {
    return /^\/[\w-]{11}\/?$/.test(url.pathname);
  }
  return (
    (url.pathname === "/watch" &&
      /^[\w-]{11}$/.test(url.searchParams.get("v") ?? "")) ||
    /^\/(?:shorts|embed)\/[\w-]{11}\/?$/.test(url.pathname)
  );
}

function youtubePostsBody(request: SocialDataRequest) {
  return {
    maxResults: request.type === "shorts" ? 0 : request.limit,
    maxResultsShorts: request.type === "shorts" ? request.limit : 0,
    maxResultStreams: 0,
    transcriptionAndSubtitle: "NONE",
    aiVideoDescription: false,
    aiVideoSummary: false,
  };
}

function youtubePlan(request: SocialDataRequest): SocialDataProviderPlan {
  if (request.operation === "search") {
    rejectOptions(request, ["sort", "date", "type"]);
    return plan(
      request,
      "/streamers/youtube-scraper",
      {
        ...youtubePostsBody(request),
        searchQueries: [request.query],
        ...(request.sort
          ? {
              sortingOrder: choice(request.sort, [
                "relevance",
                "rating",
                "date",
                "views",
              ]),
            }
          : {}),
        ...(request.date
          ? {
              dateFilter: choice(request.date, [
                "hour",
                "today",
                "week",
                "month",
                "year",
              ]),
            }
          : {}),
      },
      "youtube-post",
    );
  }
  const url = targetUrl(request);
  const content = youtubeContent(url);
  const channel =
    url.hostname !== "youtu.be" &&
    /^\/(?:@[\w.-]+|(?:channel|c|user)\/[\w.-]+)(?:\/(?:videos|shorts))?\/?$/.test(
      url.pathname,
    );
  if (request.operation === "transcript" && content) {
    rejectOptions(request, ["language"]);
    return plan(
      request,
      "/starvibe/youtube-video-transcript",
      {
        youtube_url: url.href,
        include_transcript_text: true,
        ...(request.language ? { language: request.language } : {}),
      },
      "youtube-transcript",
      1,
    );
  }
  if (request.operation === "comments" && content) {
    rejectOptions(request, ["sort"]);
    const sort = request.sort
      ? choice(request.sort, ["top", "new", "newest"])
      : "newest";
    return plan(
      request,
      "/streamers/youtube-comments-scraper",
      {
        startUrls: [{ url: url.href }],
        maxComments: request.limit,
        sortCommentsBy: sort === "top" ? "TOP_COMMENTS" : "NEWEST_FIRST",
      },
      "youtube-comment",
    );
  }
  if (request.operation === "posts" && channel) {
    rejectOptions(request, ["type", "sort"]);
    return plan(
      request,
      "/streamers/youtube-scraper",
      {
        ...youtubePostsBody(request),
        startUrls: [{ url: url.href }],
        ...(request.sort
          ? {
              sortVideosBy: choice(request.sort, [
                "newest",
                "popular",
                "oldest",
              ]).toUpperCase(),
            }
          : {}),
      },
      "youtube-post",
    );
  }
  if (request.operation === "inspect" && content) {
    rejectOptions(request);
    return plan(
      request,
      "/streamers/youtube-scraper",
      {
        ...youtubePostsBody({ ...request, limit: 1 }),
        startUrls: [{ url: url.href }],
      },
      "youtube-post",
      1,
    );
  }
  return unsupported(
    "YouTube data jobs require a video URL for details, comments, and transcripts, or a channel URL for posts.",
  );
}

function facebookPlan(request: SocialDataRequest): SocialDataProviderPlan {
  if (request.operation === "search") {
    rejectOptions(request);
    if (request.query && /[\r\n]/.test(request.query)) {
      unsupported("Facebook search accepts one query on a single line.");
    }
    return plan(
      request,
      "/cleansyntax/facebook-profile-posts-scraper",
      {
        endpoint: "search_posts_by_keyword",
        keywords_text: request.query,
        max_posts: request.limit,
      },
      "facebook-post",
    );
  }
  const url = targetUrl(request);
  const profile = /^\/(?:[\w.-]+|people\/[\w.-]+\/\d+)\/?$/.test(url.pathname);
  rejectOptions(request, request.operation === "comments" ? ["sort"] : []);
  if (
    request.operation === "inspect" &&
    profile &&
    !url.pathname.startsWith("/people/")
  ) {
    return plan(
      request,
      "/apify/facebook-pages-scraper",
      { startUrls: [{ url: url.href }] },
      "facebook-page",
      1,
    );
  }
  if (request.operation === "posts" && profile) {
    return plan(
      request,
      "/cleansyntax/facebook-profile-posts-scraper",
      {
        endpoint: "profile_posts_by_url",
        urls_text: url.href,
        max_posts: request.limit,
      },
      "facebook-post",
      request.limit + 1,
    );
  }
  const content =
    /\/(?:posts|videos|reel)\/[^/]+/.test(url.pathname) ||
    (url.pathname === "/watch/" && url.searchParams.has("v")) ||
    (url.pathname === "/photo.php" && url.searchParams.has("fbid"));
  if (request.operation === "comments" && content) {
    const sort = request.sort
      ? choice(request.sort, ["newest", "relevant", "all"])
      : "all";
    return plan(
      request,
      "/apify/facebook-comments-scraper",
      {
        startUrls: [{ url: url.href }],
        resultsLimit: request.limit,
        includeNestedComments: false,
        viewOption:
          sort === "newest"
            ? "RECENT_ACTIVITY"
            : sort === "relevant"
              ? "RANKED_THREADED"
              : "RANKED_UNFILTERED",
      },
      "facebook-comment",
    );
  }
  return unsupported(
    "Facebook data jobs support public page details, public profile posts, post search, and comments on full post or video URLs.",
  );
}

function xPlan(request: SocialDataRequest): SocialDataProviderPlan {
  const body: Record<string, unknown> = { maxItems: request.limit };
  rejectOptions(request, ["sort"]);
  if (request.sort) {
    body.sort =
      choice(request.sort, ["latest", "top"]) === "top" ? "Top" : "Latest";
  }
  if (request.operation === "search") {
    body.searchTerms = [request.query];
  } else {
    const url = targetUrl(request);
    const postId = /^\/(?:[\w]+|i)\/status\/(\d+)\/?$/.exec(url.pathname)?.[1];
    const profile = /^\/[\w]+\/?$/.test(url.pathname);
    if (request.operation === "comments" && postId) {
      body.conversationIds = [postId];
    } else if (request.operation === "inspect" && postId) {
      rejectOptions(request);
      return plan(
        request,
        "/apidojo/tweet-scraper",
        { startUrls: [url.href], maxItems: 1 },
        "x-post",
        1,
      );
    } else if (request.operation === "posts" && profile) {
      body.startUrls = [url.href];
    } else {
      unsupported(
        "X data jobs support post details, profile posts, search, and conversation comments.",
      );
    }
  }
  return plan(request, "/apidojo/tweet-scraper", body, "x-post");
}

export function prepareSocialDataProviderPlan(
  input: SocialDataRequest,
): SocialDataProviderPlan {
  const parsed = socialDataRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_INVALID_INPUT",
      "The Social data request is invalid.",
      400,
    );
  }
  const request = parsed.data;
  switch (request.platform) {
    case "instagram": {
      return instagramPlan(request);
    }
    case "tiktok": {
      return tiktokPlan(request);
    }
    case "youtube": {
      return youtubePlan(request);
    }
    case "facebook": {
      return facebookPlan(request);
    }
    case "x": {
      return xPlan(request);
    }
    case "xiaohongshu": {
      return xiaohongshuPlan(request);
    }
  }
}

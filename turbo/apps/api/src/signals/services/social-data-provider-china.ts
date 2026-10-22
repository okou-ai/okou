import {
  socialDataProviderCursorSchema,
  type SocialDataProviderCursor,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { safeUriComponentDecode } from "../utils";
import type { SocialDataProviderPlan } from "./social-data-provider-catalog";
import { SocialDataProviderError } from "./social-data-provider-error";

function unsupported(message: string): never {
  throw new SocialDataProviderError("SOCIAL_DATA_UNSUPPORTED", message, 422);
}

function options(request: SocialDataRequest, accepted: readonly string[] = []) {
  const allowed = new Set([
    "platform",
    "operation",
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

function target(request: SocialDataRequest): URL {
  const url = request.url ? URL.parse(request.url) : null;
  const hosts =
    request.platform === "douyin"
      ? ["douyin.com", "www.douyin.com"]
      : ["weibo.com", "www.weibo.com"];
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.includes(url.hostname) ||
    url.search ||
    url.hash ||
    /\\/.test(url.pathname)
  ) {
    return unsupported(
      "Use a canonical public profile or post HTTPS URL for the selected platform.",
    );
  }
  return url;
}

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

function douyinSearchPlan(request: SocialDataRequest): SocialDataProviderPlan {
  options(request, ["type"]);
  if (
    (request.type !== undefined && request.type !== "account") ||
    /[\r\n]/.test(request.query ?? "")
  ) {
    return unsupported(
      "Douyin search supports a single-line account query only.",
    );
  }
  return {
    request,
    provider: "tikhub",
    endpoint: "/api/v1/douyin/search/fetch_user_search_v2",
    input: { body: { keyword: request.query, cursor: 0 } },
    format: "douyin-user-search",
    maxBillableUnits: 1,
  };
}

export function douyinPlan(request: SocialDataRequest): SocialDataProviderPlan {
  if (request.operation === "search") {
    return douyinSearchPlan(request);
  }
  const url = target(request);
  const profile = /^\/user\/([A-Za-z0-9_-]{1,256})\/?$/.exec(url.pathname)?.[1];
  const post = /^\/video\/(\d{1,128})\/?$/.exec(url.pathname)?.[1];
  if (request.operation === "inspect" && profile) {
    options(request);
    return queryPlan(
      request,
      "/api/v1/douyin/web/handler_user_profile",
      { sec_user_id: profile },
      "douyin-user",
    );
  }
  if (request.operation === "posts" && profile) {
    options(request, ["sort"]);
    if (
      request.sort !== undefined &&
      !["latest", "popular"].includes(request.sort)
    ) {
      return unsupported("Douyin posts support latest or popular sorting.");
    }
    return queryPlan(
      request,
      "/api/v1/douyin/app/v3/fetch_user_post_videos",
      {
        sec_user_id: profile,
        max_cursor: 0,
        count: Math.min(request.limit, 20),
        sort_type: request.sort === "popular" ? 1 : 0,
        channel: "normal",
      },
      "douyin-post",
    );
  }
  if (request.operation === "comments" && post) {
    options(request);
    return queryPlan(
      request,
      "/api/v1/douyin/app/v3/fetch_video_comments",
      {
        aweme_id: post,
        cursor: 0,
        count: 20,
      },
      "douyin-comment",
    );
  }
  if (request.operation === "replies" && post) {
    options(request, ["commentId"]);
    return queryPlan(
      request,
      "/api/v1/douyin/app/v3/fetch_video_comment_replies",
      {
        item_id: post,
        comment_id: request.commentId,
        cursor: 0,
        count: 20,
      },
      "douyin-comment",
    );
  }
  if (
    (request.operation === "followers" || request.operation === "following") &&
    profile
  ) {
    options(request);
    return request.operation === "followers"
      ? queryPlan(
          request,
          "/api/v1/douyin/app/v3/fetch_user_fans_list",
          {
            sec_user_id: profile,
            max_time: "0",
            count: 20,
          },
          "douyin-followers",
        )
      : queryPlan(
          request,
          "/api/v1/douyin/web/fetch_user_following_list",
          {
            sec_user_id: profile,
            max_time: "0",
            source_type: 2,
            count: 20,
          },
          "douyin-following",
        );
  }
  return unsupported(
    "Douyin requires a profile URL for inspect/posts/followers/following or a numeric video URL for comments/replies.",
  );
}

function weiboCustomUsername(url: URL): string | undefined {
  const encoded = /^\/n\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (!encoded) {
    return undefined;
  }
  const decoded = safeUriComponentDecode(encoded);
  return decoded !== undefined && /^[\p{L}\p{N}_-]{1,128}$/u.test(decoded)
    ? decoded
    : undefined;
}

export function weiboPlan(request: SocialDataRequest): SocialDataProviderPlan {
  if (request.operation === "search") {
    options(request, ["type"]);
    if (
      (request.type !== undefined && request.type !== "post") ||
      /[\r\n]/.test(request.query ?? "")
    ) {
      return unsupported(
        "Weibo search supports a single-line realtime post query only.",
      );
    }
    return queryPlan(
      request,
      "/api/v1/weibo/web_v2/fetch_realtime_search",
      {
        query: request.query,
        page: 1,
      },
      "weibo-search",
    );
  }
  const url = target(request);
  const uid = /^\/u\/(\d{1,128})\/?$/.exec(url.pathname)?.[1];
  const custom = weiboCustomUsername(url);
  const post = /^\/(\d{1,128})\/(\d{1,128})\/?$/.exec(url.pathname)?.[2];
  if (request.operation === "inspect" && (uid || custom)) {
    options(request);
    return queryPlan(
      request,
      "/api/v1/weibo/web_v2/fetch_user_info",
      uid ? { uid } : { custom },
      "weibo-user",
    );
  }
  if (request.operation === "posts" && uid) {
    options(request);
    return queryPlan(
      request,
      "/api/v1/weibo/app/fetch_user_timeline",
      {
        uid,
        page: 1,
        filter_type: "all",
      },
      "weibo-post",
    );
  }
  if (
    (request.operation === "comments" || request.operation === "replies") &&
    post
  ) {
    options(request, request.operation === "replies" ? ["commentId"] : []);
    return queryPlan(
      request,
      request.operation === "replies"
        ? "/api/v1/weibo/web_v2/fetch_post_sub_comments"
        : "/api/v1/weibo/web_v2/fetch_post_comments",
      {
        id: request.operation === "replies" ? request.commentId : post,
        count: 10,
      },
      "weibo-comment",
    );
  }
  return unsupported(
    "Weibo requires a canonical profile URL for inspect, a numeric /u/ UID for posts, or /author-id/numeric-post-id for comments/replies.",
  );
}

function douyinCursorInput(
  plan: SocialDataProviderPlan,
  value: SocialDataProviderCursor,
): SocialDataProviderPlan["input"] | undefined {
  const query = plan.input.queryParams;
  let input: SocialDataProviderPlan["input"] | undefined;
  switch (value.kind) {
    case "douyin-cursor": {
      if (plan.format === "douyin-user-search") {
        input = {
          body: { keyword: plan.request.query, cursor: value.value },
        };
      } else if (plan.format === "douyin-comment") {
        input = { queryParams: { ...query, cursor: value.value } };
      }
      break;
    }
    case "douyin-max-cursor": {
      if (plan.format === "douyin-post") {
        input = { queryParams: { ...query, max_cursor: value.value } };
      }
      break;
    }
    case "douyin-max-time": {
      if (plan.format === "douyin-following" && value.sourceType === 1) {
        input = {
          queryParams: { ...query, max_time: value.value, source_type: 1 },
        };
      } else if (
        plan.format === "douyin-followers" &&
        value.sourceType === undefined
      ) {
        input = { queryParams: { ...query, max_time: value.value } };
      }
      break;
    }
  }
  return input;
}

function weiboCursorInput(
  plan: SocialDataProviderPlan,
  value: SocialDataProviderCursor,
): SocialDataProviderPlan["input"] | undefined {
  const query = plan.input.queryParams;
  let input: SocialDataProviderPlan["input"] | undefined;
  if (
    value.kind === "weibo-page" &&
    (plan.format === "weibo-post" || plan.format === "weibo-search")
  ) {
    input = { queryParams: { ...query, page: value.value } };
  } else if (value.kind === "weibo-max-id" && plan.format === "weibo-comment") {
    input = { queryParams: { ...query, max_id: value.value } };
  }
  return input;
}

/** Rebuild pagination only; never merge supplier-provided input into a plan. */
export function withSocialDataCursor(
  plan: SocialDataProviderPlan,
  cursor: SocialDataProviderCursor | undefined,
): SocialDataProviderPlan {
  if (cursor === undefined) {
    return plan;
  }
  const checked = socialDataProviderCursorSchema.safeParse(cursor);
  if (!checked.success) {
    return unsupported("The Social data continuation is invalid.");
  }
  const value = checked.data;
  const input =
    plan.request.platform === "douyin"
      ? douyinCursorInput(plan, value)
      : plan.request.platform === "weibo"
        ? weiboCursorInput(plan, value)
        : undefined;
  if (!input) {
    return unsupported(
      "This continuation does not belong to the selected Social operation.",
    );
  }
  return { ...plan, input, cursor: value };
}

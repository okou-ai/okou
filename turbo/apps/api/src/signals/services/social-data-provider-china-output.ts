import {
  SOCIAL_DATA_MAX_RESULTS,
  type SocialDataProviderCursor,
  type SocialDataRecord,
  type SocialDataResult,
} from "@okouai/api-contracts/contracts/social-data";
import { z } from "zod";
import type { SocialDataProviderPlan } from "./social-data-provider-catalog";
import { SocialDataProviderError } from "./social-data-provider-error";

const id = z.string().regex(/^\d{1,128}$/u);
const secId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const upstreamId = z.union([id, integer]).transform((value) => {
  return String(value);
});
const count = z
  .union([integer, z.string().regex(/^\d{1,16}$/u)])
  .transform((value) => {
    return Number(value);
  })
  .pipe(integer);
const flag = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => {
    return value === true || value === 1;
  });
const urls = z.object({ url_list: z.array(z.string()).optional() });
const dyUser = z.object({
  uid: upstreamId,
  sec_uid: secId.optional(),
  unique_id: z.string().optional(),
  short_id: z.string().optional(),
  nickname: z.string().optional(),
  signature: z.string().optional(),
  follower_count: count.optional(),
  following_count: count.optional(),
  aweme_count: count.optional(),
  avatar_thumb: urls.optional(),
});
const dyPost = z.object({
  aweme_id: upstreamId,
  desc: z.string().optional(),
  create_time: integer.optional(),
  author: dyUser.optional(),
  statistics: z
    .object({
      play_count: count.optional(),
      digg_count: count.optional(),
      comment_count: count.optional(),
      share_count: count.optional(),
    })
    .optional(),
  video: z
    .object({
      play_addr: urls.optional(),
      cover: urls.optional(),
      duration: integer.optional(),
    })
    .optional(),
});
const dyComment = z.object({
  cid: upstreamId,
  text: z.string().optional(),
  user: dyUser.optional(),
  create_time: integer.optional(),
  digg_count: count.optional(),
  reply_comment_total: count.optional(),
  reply_id: upstreamId.optional(),
});
const wbUser = z
  .object({
    idstr: id.optional(),
    id: upstreamId.optional(),
    screen_name: z.string().optional(),
    description: z.string().optional(),
    followers_count: count.optional(),
    friends_count: count.optional(),
    statuses_count: count.optional(),
    avatar_hd: z.string().optional(),
  })
  .refine((user) => {
    return user.idstr !== undefined || user.id !== undefined;
  });
const wbPost = z
  .object({
    idstr: id.optional(),
    id: upstreamId.optional(),
    mblogid: z
      .string()
      .regex(/^[A-Za-z0-9]+$/u)
      .optional(),
    text: z.string().optional(),
    text_raw: z.string().optional(),
    created_at: z.string().optional(),
    user: wbUser.optional(),
    attitudes_count: count.optional(),
    comments_count: count.optional(),
    reposts_count: count.optional(),
    pics: z
      .array(
        z.object({
          large: z.object({ url: z.string() }).optional(),
          url: z.string().optional(),
        }),
      )
      .optional(),
  })
  .refine((post) => {
    return post.idstr !== undefined || post.id !== undefined;
  });
const wbComment = z
  .object({
    idstr: id.optional(),
    id: upstreamId.optional(),
    text: z.string().optional(),
    created_at: z.string().optional(),
    user: wbUser.optional(),
    like_counts: count.optional(),
    total_number: count.optional(),
    rootid: upstreamId.optional(),
  })
  .refine((comment) => {
    return comment.idstr !== undefined || comment.id !== undefined;
  });

const pageFields = Object.freeze({
  has_more: flag.optional(),
  cursor: integer.optional(),
  max_cursor: integer.optional(),
  max_time: z
    .string()
    .regex(/^\d{1,128}$/u)
    .optional(),
  max_id: z.union([id, z.literal("")]).optional(),
});
const dyData = z.object({
  ...pageFields,
  status_code: z.literal(0).optional(),
  user: dyUser.optional(),
  aweme_list: z.array(dyPost).optional(),
  comments: z.array(dyComment).optional(),
  followers: z.array(dyUser).optional(),
  followings: z.array(dyUser).optional(),
});
const wbData = z.object({
  ...pageFields,
  ok: z.literal(1).optional(),
  userInfo: wbUser.optional(),
  user: wbUser.optional(),
  statuses: z.array(wbPost).optional(),
  data: z.array(wbComment).optional(),
});

// These search endpoints do not return the profile/post endpoint envelopes.
const dySearchData = z.object({
  ...pageFields,
  user_list: z.array(
    z.object({
      user_id: secId,
      nick_name: z.string().optional(),
      fans_cnt: count.optional(),
      publish_cnt: count.optional(),
      avatar_url: z.string().optional(),
    }),
  ),
});
const wbSearchData = z.object({
  parse_success: z.literal(true),
  results: z.array(
    z.object({
      weibo_id: id,
      user_nick: z.string().optional(),
      user_url: z.string(),
      post_url: z.string(),
      content: z.string().optional(),
      publish_time: z.string().optional(),
      interaction: z
        .object({
          repost_count: count.optional(),
          comment_count: count.optional(),
          like_count: count.optional(),
        })
        .optional(),
      media: z
        .object({
          images: z.array(z.string()).optional(),
          videos: z
            .array(
              z.object({
                streams: z.array(z.string()).optional(),
                src: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
  ),
});

function invalid(): never {
  throw new SocialDataProviderError(
    "SOCIAL_DATA_INVALID_RESULT",
    "The Social data service returned an unsupported result.",
  );
}

/** Explicit compatible envelopes, not a recursive search for arbitrary data arrays. */
function douyinData(output: unknown) {
  const parsed = z
    .object({ code: z.literal(200).optional(), data: dyData })
    .safeParse(output);
  return parsed.success ? parsed.data.data : invalid();
}
function weiboData(output: unknown) {
  const parsed = z
    .object({ code: z.literal(200).optional(), data: wbData })
    .safeParse(output);
  return parsed.success ? parsed.data.data : invalid();
}

function douyinSearchData(output: unknown) {
  const parsed = z
    .object({ code: z.literal(0), data: dySearchData })
    .safeParse(output);
  return parsed.success ? parsed.data.data : invalid();
}

function weiboSearchRows(output: unknown): SocialDataRecord[] {
  const parsed = z.object({ parsed_data: wbSearchData }).safeParse(output);
  if (!parsed.success) {
    return invalid();
  }
  return parsed.data.parsed_data.results.map((post) => {
    const author = weiboSearchUrl(post.user_url);
    const authorId = /^\/(?:u\/)?(\d{1,128})\/?$/u.exec(author.pathname)?.[1];
    const url = weiboSearchUrl(post.post_url);
    const postAuthorId = /^\/(\d{1,128})\/[A-Za-z0-9]+\/?$/u.exec(
      url.pathname,
    )?.[1];
    if (!authorId || authorId !== postAuthorId) {
      return invalid();
    }
    return {
      id: post.weibo_id,
      url: url.href,
      text: post.content,
      // Keep the provider's relative publication text; do not invent an absolute date.
      publishedAt: post.publish_time,
      authorId,
      authorUrl: `https://weibo.com/u/${authorId}`,
      displayName: post.user_nick,
      likes: post.interaction?.like_count,
      comments: post.interaction?.comment_count,
      shares: post.interaction?.repost_count,
      mediaUrls: media([
        ...(post.media?.images ?? []),
        ...(post.media?.videos?.flatMap((video) => {
          return [...(video.streams ?? []), video.src];
        }) ?? []),
      ]),
    };
  });
}

function weiboSearchUrl(value: string): URL {
  const url = URL.parse(value.startsWith("//") ? `https:${value}` : value);
  if (
    !url ||
    url.protocol !== "https:" ||
    !["weibo.com", "www.weibo.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return invalid();
  }
  url.search = "";
  url.hash = "";
  return url;
}

function media(values: readonly (string | undefined)[]): string[] | undefined {
  const hosts = [
    "douyincdn.com",
    "douyinpic.com",
    "douyinvod.com",
    "byteimg.com",
    "bytecdn.cn",
    "bytedance.com",
    "pstatp.com",
    "snssdk.com",
    "sinaimg.cn",
    "sinaimg.com",
    "weibocdn.com",
    "weibo.cn",
  ];
  const result = values.flatMap((value) => {
    const url = value ? URL.parse(value) : null;
    if (
      !url ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !hosts.some((host) => {
        return url.hostname === host || url.hostname.endsWith(`.${host}`);
      })
    ) {
      return [];
    }
    return [url.href];
  });
  return result.length ? [...new Set(result)] : undefined;
}
function time(value: number | undefined): string | undefined {
  return value !== undefined && value <= 8_640_000_000_000
    ? new Date(value * 1000).toISOString()
    : undefined;
}
function dyProfile(user: z.infer<typeof dyUser>): string | undefined {
  return user.sec_uid
    ? `https://www.douyin.com/user/${user.sec_uid}`
    : undefined;
}
function projectDyUser(user: z.infer<typeof dyUser>): SocialDataRecord {
  return {
    id: user.uid,
    url: dyProfile(user),
    username: user.unique_id || user.short_id,
    displayName: user.nickname,
    description: user.signature,
    followers: user.follower_count,
    following: user.following_count,
    posts: user.aweme_count,
    mediaUrls: media(user.avatar_thumb?.url_list ?? []),
  };
}
function projectWbUser(user: z.infer<typeof wbUser>): SocialDataRecord {
  const uid = user.idstr ?? user.id;
  return {
    id: uid,
    url: `https://weibo.com/u/${uid}`,
    displayName: user.screen_name,
    description: user.description,
    followers: user.followers_count,
    following: user.friends_count,
    posts: user.statuses_count,
    mediaUrls: media([user.avatar_hd]),
  };
}

function douyinRows(
  plan: SocialDataProviderPlan,
  output: unknown,
): SocialDataRecord[] {
  if (plan.format === "douyin-user-search") {
    return douyinSearchData(output).user_list.map((user) => {
      return {
        // user_id is a sec_uid on this endpoint, not a numeric uid.
        id: user.user_id,
        url: `https://www.douyin.com/user/${user.user_id}`,
        displayName: user.nick_name,
        followers: user.fans_cnt,
        posts: user.publish_cnt,
        mediaUrls: media([user.avatar_url]),
      };
    });
  }
  const data = douyinData(output);
  switch (plan.format) {
    case "douyin-user": {
      return data.user ? [projectDyUser(data.user)] : invalid();
    }
    case "douyin-followers": {
      return data.followers?.map(projectDyUser) ?? invalid();
    }
    case "douyin-following": {
      return data.followings?.map(projectDyUser) ?? invalid();
    }
    case "douyin-post": {
      return (
        data.aweme_list?.map((post) => {
          return {
            id: post.aweme_id,
            url: `https://www.douyin.com/video/${post.aweme_id}`,
            text: post.desc,
            publishedAt: time(post.create_time),
            authorId: post.author?.uid,
            authorUrl: post.author ? dyProfile(post.author) : undefined,
            username: post.author?.unique_id,
            displayName: post.author?.nickname,
            likes: post.statistics?.digg_count,
            views: post.statistics?.play_count,
            comments: post.statistics?.comment_count,
            shares: post.statistics?.share_count,
            duration:
              post.video?.duration === undefined
                ? undefined
                : post.video.duration / 1000,
            mediaUrls: media([
              ...(post.video?.play_addr?.url_list ?? []),
              ...(post.video?.cover?.url_list ?? []),
            ]),
          };
        }) ?? invalid()
      );
    }
    case "douyin-comment": {
      return (
        data.comments?.map((comment) => {
          return {
            id: comment.cid,
            text: comment.text,
            publishedAt: time(comment.create_time),
            authorId: comment.user?.uid,
            authorUrl: comment.user ? dyProfile(comment.user) : undefined,
            username: comment.user?.unique_id,
            displayName: comment.user?.nickname,
            likes: comment.digg_count,
            replies: comment.reply_comment_total,
            parentId:
              plan.request.operation === "replies"
                ? plan.request.commentId
                : comment.reply_id,
          };
        }) ?? invalid()
      );
    }
  }
  return invalid();
}

function weiboRows(
  plan: SocialDataProviderPlan,
  output: unknown,
): SocialDataRecord[] {
  if (plan.format === "weibo-search") {
    return weiboSearchRows(output);
  }
  const data = weiboData(output);
  if (plan.format === "weibo-user") {
    const user = data.userInfo ?? data.user;
    return user ? [projectWbUser(user)] : invalid();
  }
  if (plan.format === "weibo-comment") {
    return (
      data.data?.map((comment) => {
        return {
          id: comment.idstr ?? comment.id,
          text: comment.text,
          publishedAt: comment.created_at,
          authorId: comment.user?.idstr ?? comment.user?.id,
          authorUrl: comment.user ? projectWbUser(comment.user).url : undefined,
          displayName: comment.user?.screen_name,
          likes: comment.like_counts,
          replies: comment.total_number,
          parentId:
            plan.request.operation === "replies"
              ? plan.request.commentId
              : comment.rootid,
        };
      }) ?? invalid()
    );
  }
  return (
    data.statuses?.map((post) => {
      const postId = post.idstr ?? post.id;
      const authorId = post.user?.idstr ?? post.user?.id;
      return {
        id: postId,
        url: authorId ? `https://weibo.com/${authorId}/${postId}` : undefined,
        text: post.text_raw ?? post.text,
        publishedAt: post.created_at,
        authorId,
        authorUrl: post.user ? projectWbUser(post.user).url : undefined,
        displayName: post.user?.screen_name,
        likes: post.attitudes_count,
        comments: post.comments_count,
        shares: post.reposts_count,
        mediaUrls: media(
          post.pics?.map((pic) => {
            return pic.large?.url ?? pic.url;
          }) ?? [],
        ),
      };
    }) ?? invalid()
  );
}

function chinaRows(
  plan: SocialDataProviderPlan,
  output: unknown,
): SocialDataRecord[] {
  return plan.request.platform === "douyin"
    ? douyinRows(plan, output)
    : weiboRows(plan, output);
}

export interface SocialDataProviderContinuation {
  readonly nextCursor?: SocialDataProviderCursor;
  readonly hasMore?: boolean;
}

export function extractChinaContinuation(
  plan: SocialDataProviderPlan,
  output: unknown,
): SocialDataProviderContinuation {
  if (plan.request.platform !== "douyin" && plan.request.platform !== "weibo") {
    return {};
  }
  // Validate the same typed rows before allowing a cursor to cause another billed request.
  chinaRows(plan, output);
  if (plan.format === "weibo-search") {
    // Realtime search supplies no trusted source-end flag or continuation token.
    return {};
  }
  const data = chinaPageData(plan, output);
  const initializingFollowing =
    plan.format === "douyin-following" && plan.cursor === undefined;
  if (data.has_more === false && !initializingFollowing) {
    return { hasMore: false };
  }
  if (
    plan.format === "weibo-comment" &&
    (data.max_id === "" || data.max_id === "0")
  ) {
    return plan.request.operation === "comments" ? { hasMore: false } : {};
  }
  const nextCursor = chinaNextCursor(plan, data);
  if (
    nextCursor &&
    plan.cursor &&
    nextCursor.kind === plan.cursor.kind &&
    nextCursor.value === plan.cursor.value
  ) {
    return {}; // A repeated token is not a trusted continuation or proof of end.
  }
  return {
    ...(nextCursor ? { nextCursor } : {}),
    ...(initializingFollowing && nextCursor
      ? { hasMore: true }
      : data.has_more === undefined
        ? {}
        : { hasMore: data.has_more }),
  };
}

function chinaPageData(plan: SocialDataProviderPlan, output: unknown) {
  if (plan.format === "douyin-user-search") {
    return douyinSearchData(output);
  }
  return plan.request.platform === "douyin"
    ? douyinData(output)
    : weiboData(output);
}

function chinaNextCursor(
  plan: SocialDataProviderPlan,
  data:
    | z.infer<typeof dyData>
    | z.infer<typeof wbData>
    | z.infer<typeof dySearchData>,
): SocialDataProviderCursor | undefined {
  let nextCursor: SocialDataProviderCursor | undefined;
  switch (plan.format) {
    case "douyin-user-search":
    case "douyin-comment": {
      if (data.cursor !== undefined && data.cursor > 0) {
        nextCursor = { kind: "douyin-cursor", value: data.cursor };
      }
      break;
    }
    case "douyin-post": {
      if (data.max_cursor !== undefined && data.max_cursor > 0) {
        nextCursor = { kind: "douyin-max-cursor", value: data.max_cursor };
      }
      break;
    }
    case "douyin-followers":
    case "douyin-following": {
      if (data.max_time !== undefined && !/^0+$/.test(data.max_time)) {
        nextCursor = {
          kind: "douyin-max-time",
          value: data.max_time,
          ...(plan.format === "douyin-following"
            ? { sourceType: 1 as const }
            : {}),
        };
      }
      break;
    }
    case "weibo-comment": {
      if (data.max_id !== undefined) {
        nextCursor = { kind: "weibo-max-id", value: data.max_id };
      }
      break;
    }
    case "weibo-post":
    case "weibo-search": {
      nextCursor = weiboNextPage(plan, data.has_more);
      break;
    }
  }
  return nextCursor;
}

function weiboNextPage(
  plan: SocialDataProviderPlan,
  hasMore: boolean | undefined,
): SocialDataProviderCursor | undefined {
  // Page input alone does not prove there is another page. Require an explicit source flag.
  const page = plan.cursor?.kind === "weibo-page" ? plan.cursor.value : 1;
  return hasMore === true && page < Number.MAX_SAFE_INTEGER
    ? { kind: "weibo-page", value: page + 1 }
    : undefined;
}

export function projectChinaOutput(
  plan: SocialDataProviderPlan,
  output: unknown,
): SocialDataResult {
  // The collection owner applies the remaining limit after cross-page identity
  // deduplication, so duplicates cannot hide later valid records in this page.
  const items = chinaRows(plan, output).slice(0, SOCIAL_DATA_MAX_RESULTS);
  const continuation = extractChinaContinuation(plan, output);
  return { items, pagination: { hasMore: continuation.hasMore ?? null } };
}

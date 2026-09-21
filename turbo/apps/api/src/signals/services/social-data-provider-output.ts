import type {
  SocialDataRecord,
  SocialDataResult,
} from "@okouai/api-contracts/contracts/social-data";

import {
  SocialDataProviderError,
  type SocialDataProviderPlan,
} from "./social-data-provider-catalog";

type ObjectValue = Readonly<Record<string, unknown>>;

function invalidOutput(): never {
  throw new SocialDataProviderError(
    "SOCIAL_DATA_INVALID_RESULT",
    "The Social data service returned an unsupported result.",
  );
}

function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidOutput();
  }
  return value as ObjectValue;
}

function nested(value: ObjectValue, key: string): ObjectValue {
  const child = value[key];
  return child === undefined || child === null ? {} : object(child);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  const parsed =
    typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : value;
  return typeof parsed === "number" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= Number.MAX_SAFE_INTEGER
    ? parsed
    : undefined;
}

function count(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed !== undefined && Number.isSafeInteger(parsed)
    ? parsed
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const seconds = number(value);
  if (seconds === undefined || seconds > 8_640_000_000_000) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString();
}

function sourceUrl(value: unknown): string | undefined {
  const parsed = typeof value === "string" ? URL.parse(value) : null;
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return undefined;
  }
  const allowed = [
    "instagram.com",
    "tiktok.com",
    "youtube.com",
    "youtu.be",
    "facebook.com",
    "x.com",
    "twitter.com",
  ];
  return allowed.some((host) => {
    return (
      parsed.hostname === host ||
      parsed.hostname === `www.${host}` ||
      parsed.hostname === `m.${host}`
    );
  })
    ? parsed.href
    : undefined;
}

function mediaUrl(value: unknown): string | undefined {
  const parsed = typeof value === "string" ? URL.parse(value) : null;
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return undefined;
  }
  const domains = [
    "cdninstagram.com",
    "fbcdn.net",
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "tiktokcdn-eu.net",
    "ibytedtos.com",
    "byteoversea.com",
    "ytimg.com",
    "googlevideo.com",
    "googleusercontent.com",
    "twimg.com",
  ];
  return domains.some((host) => {
    return parsed.hostname === host || parsed.hostname.endsWith(`.${host}`);
  })
    ? parsed.href
    : undefined;
}

function media(values: readonly unknown[]): string[] | undefined {
  const urls = values
    .flatMap((value) => {
      return Array.isArray(value) ? value : [value];
    })
    .map(mediaUrl)
    .filter((value) => {
      return value !== undefined;
    });
  return urls.length ? [...new Set(urls)] : undefined;
}

function duration(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+(?::\d{2}){1,2}$/.test(value)) {
    return value.split(":").reduce((total, part) => {
      return total * 60 + Number(part);
    }, 0);
  }
  return number(value);
}

function projectInstagram(
  row: ObjectValue,
  format: SocialDataProviderPlan["format"],
): SocialDataRecord {
  if (format === "instagram-profile") {
    return {
      id: string(row.id),
      url: sourceUrl(row.url),
      username: string(row.username),
      displayName: string(row.fullName),
      description: string(row.biography),
      followers: count(row.followersCount),
      following: count(row.followsCount),
      posts: count(row.postsCount),
    };
  }
  if (format === "instagram-comment") {
    const owner = nested(row, "owner");
    return {
      id: string(row.id),
      url: sourceUrl(row.url),
      text: string(row.text),
      publishedAt: timestamp(row.created_at),
      username: string(owner.username),
      likes: count(row.likesCount),
      replies: count(row.repliesCount),
    };
  }
  return {
    id: string(row.id),
    url: sourceUrl(row.url),
    text: string(row.caption),
    publishedAt: timestamp(row.timestamp),
    username: string(row.ownerUsername),
    displayName: string(row.ownerFullName),
    likes: count(row.likesCount),
    comments: count(row.commentsCount),
    views: count(row.videoViewCount),
    duration: duration(row.videoDuration),
    mediaUrls: media([row.displayUrl, row.videoUrl, row.images]),
  };
}

function projectTiktok(row: ObjectValue, comments: boolean): SocialDataRecord {
  if (comments) {
    const user = nested(row, "user");
    return {
      id: string(row.cid),
      text: string(row.text),
      publishedAt: timestamp(row.create_time),
      username: string(user.unique_id),
      displayName: string(user.nickname),
      likes: count(row.digg_count),
      replies: count(row.reply_comment_total),
      parentId: string(row.reply_id),
    };
  }
  const channel = nested(row, "channel");
  const video = nested(row, "video");
  return {
    id: string(row.id),
    url: sourceUrl(row.postPage),
    text: string(row.title),
    publishedAt: timestamp(row.uploadedAtFormatted ?? row.uploadedAt),
    username: string(channel.username),
    displayName: string(channel.name),
    followers: count(channel.followers),
    following: count(channel.following),
    posts: count(channel.videos),
    views: count(row.views),
    likes: count(row.likes),
    comments: count(row.comments),
    shares: count(row.shares),
    duration: duration(video.duration),
    mediaUrls: media([video.url, video.cover, video.thumbnail]),
  };
}

function projectYoutube(row: ObjectValue, comments: boolean): SocialDataRecord {
  if (comments) {
    return {
      id: string(row.cid),
      url: sourceUrl(row.pageUrl),
      text: string(row.comment),
      title: string(row.title),
      username: string(row.author),
      publishedAt: timestamp(row.publishedAtTime),
      likes: count(row.voteCount),
      replies: count(row.replyCount),
      parentId: string(row.replyToCid),
    };
  }
  return {
    id: string(row.id),
    url: sourceUrl(row.url),
    title: string(row.title),
    description: string(row.text),
    publishedAt: timestamp(row.date),
    displayName: string(row.channelName),
    views: count(row.viewCount),
    likes: count(row.likes),
    comments: count(row.commentsCount),
    followers: count(row.numberOfSubscribers),
    duration: duration(row.duration),
    mediaUrls: media([row.thumbnailUrl]),
  };
}

function projectFacebook(
  row: ObjectValue,
  format: SocialDataProviderPlan["format"],
): SocialDataRecord {
  if (format === "facebook-page") {
    return {
      id: string(row.pageId),
      url: sourceUrl(row.pageUrl),
      username: string(row.pageName),
      displayName: string(row.title),
      description: string(row.intro),
      followers: count(row.followers),
      likes: count(row.likes),
      mediaUrls: media([row.profilePictureUrl, row.coverPhotoUrl]),
    };
  }
  if (format === "facebook-comment") {
    return {
      id: string(row.commentId),
      url: sourceUrl(row.commentUrl),
      text: string(row.text),
      publishedAt: timestamp(row.date),
      displayName: string(row.profileName),
      likes: count(row.likesCount),
    };
  }
  return {
    id: string(row.post_id),
    url: sourceUrl(row.url),
    text: string(row.message),
    publishedAt: timestamp(row.timestamp),
    comments: count(row.comments_count),
    reactions: count(row.reactions_count),
    shares: count(row.reshare_count),
    mediaUrls: media([row.image, row.video, row.video_thumbnail]),
  };
}

function projectX(row: ObjectValue): SocialDataRecord {
  const author = nested(row, "author");
  return {
    id: string(row.id),
    url: sourceUrl(row.url),
    text: string(row.text),
    publishedAt: timestamp(row.createdAt),
    username: string(author.userName),
    displayName: string(author.name),
    followers: count(author.followers),
    following: count(author.following),
    views: count(row.viewCount),
    likes: count(row.likeCount),
    comments: count(row.replyCount),
    replies: count(row.replyCount),
    shares: count(row.retweetCount),
    parentId: string(row.inReplyToId),
  };
}

function projectRecord(
  row: ObjectValue,
  plan: SocialDataProviderPlan,
): SocialDataRecord {
  if (row.error !== undefined && row.error !== null) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_CONTENT_UNAVAILABLE",
      "The requested social content could not be retrieved.",
    );
  }
  switch (plan.request.platform) {
    case "instagram": {
      return projectInstagram(row, plan.format);
    }
    case "tiktok": {
      return projectTiktok(row, plan.format === "tiktok-comment");
    }
    case "youtube": {
      return projectYoutube(row, plan.format === "youtube-comment");
    }
    case "facebook": {
      return projectFacebook(row, plan.format);
    }
    case "x": {
      return projectX(row);
    }
  }
}

function transcript(rows: readonly unknown[]): SocialDataResult {
  if (rows.length !== 1) {
    return invalidOutput();
  }
  const row = object(rows[0]);
  if (row.status !== "success" || !Array.isArray(row.transcript)) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_TRANSCRIPT_UNAVAILABLE",
      "A transcript is unavailable for this video.",
    );
  }
  const segments = row.transcript.map((value: unknown) => {
    const segment = object(value);
    const text = string(segment.text);
    const start = number(segment.start);
    const end = number(segment.end);
    if (!text || start === undefined || end === undefined || end < start) {
      return invalidOutput();
    }
    return { text, start, duration: end - start };
  });
  return {
    transcript:
      string(row.transcript_text) ??
      segments
        .map((segment) => {
          return segment.text;
        })
        .join(" "),
    segments,
    language: string(row.language),
  };
}

function isCollectionContext(
  row: ObjectValue,
  plan: SocialDataProviderPlan,
): boolean {
  if (plan.format === "facebook-post") {
    return row.post_id === undefined && row.profileID !== undefined;
  }
  if (
    plan.request.platform === "x" &&
    plan.request.operation === "comments" &&
    plan.request.url
  ) {
    return (
      row.id ===
      new URL(plan.request.url).pathname.split("/").filter(Boolean).at(-1)
    );
  }
  return false;
}

export function projectSocialDataProviderOutput(
  plan: SocialDataProviderPlan,
  output: unknown,
): SocialDataResult {
  let rows: readonly unknown[];
  if (plan.format === "tiktok-comment") {
    const payload =
      Array.isArray(output) && output.length === 1
        ? object(output[0])
        : object(output);
    if (!Array.isArray(payload.comments)) {
      return invalidOutput();
    }
    rows = payload.comments;
  } else {
    if (!Array.isArray(output)) {
      return invalidOutput();
    }
    rows = output;
  }
  if (plan.format === "youtube-transcript") {
    return transcript(rows);
  }
  const items: SocialDataRecord[] = [];
  for (const value of rows) {
    const row = object(value);
    if (isCollectionContext(row, plan)) {
      continue;
    }
    const projected = projectRecord(row, plan);
    if (
      !projected.id &&
      !projected.text &&
      !projected.title &&
      !projected.username &&
      !projected.displayName
    ) {
      return invalidOutput();
    }
    items.push(projected);
    if (items.length >= plan.request.limit) {
      break;
    }
  }
  return { items };
}

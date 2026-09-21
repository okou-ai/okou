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

function edgeCount(row: ObjectValue, key: string): number | undefined {
  return count(nested(row, key).count);
}

function captionText(row: ObjectValue): string | undefined {
  const edges = nested(row, "edge_media_to_caption").edges;
  if (!Array.isArray(edges) || edges.length === 0) {
    return undefined;
  }
  return string(nested(object(edges[0]), "node").text);
}

function instagramMedia(row: ObjectValue): SocialDataRecord {
  const shortcode = string(row.shortcode);
  return {
    id: string(row.id),
    url: shortcode
      ? sourceUrl(`https://www.instagram.com/p/${shortcode}/`)
      : undefined,
    text: captionText(row) ?? string(row.accessibility_caption),
    publishedAt: timestamp(row.taken_at_timestamp),
    username: string(nested(row, "owner").username),
    // Instagram exposes the like count under different edges depending on
    // whether the media came from a profile feed or a single-post lookup.
    likes:
      edgeCount(row, "edge_liked_by") ??
      edgeCount(row, "edge_media_preview_like"),
    comments:
      edgeCount(row, "edge_media_to_comment") ??
      edgeCount(row, "edge_media_preview_comment"),
    views: count(row.video_view_count),
    duration: duration(row.video_duration),
    mediaUrls: media([row.display_url]),
  };
}

function projectInstagram(
  row: ObjectValue,
  plan: SocialDataProviderPlan,
): SocialDataRecord {
  if (plan.format === "instagram-comment") {
    return {
      id: string(row.pk) ?? string(row.id),
      text: string(row.text),
      publishedAt: timestamp(row.created_at),
      username: string(nested(row, "user").username),
      displayName: string(nested(row, "user").full_name),
      likes: count(row.comment_like_count),
      replies: count(row.child_comment_count),
    };
  }
  if (
    plan.format === "instagram-user" &&
    plan.request.operation === "inspect"
  ) {
    const username = string(row.username);
    return {
      id: string(row.id),
      url: username
        ? sourceUrl(`https://www.instagram.com/${username}/`)
        : undefined,
      username,
      displayName: string(row.full_name),
      description: string(row.biography),
      followers: edgeCount(row, "edge_followed_by"),
      following: edgeCount(row, "edge_follow"),
      posts: edgeCount(row, "edge_owner_to_timeline_media"),
    };
  }
  return instagramMedia(row);
}

function xiaohongshuNoteUrl(id: string | undefined): string | undefined {
  return id
    ? sourceUrl(`https://www.xiaohongshu.com/explore/${id}`)
    : undefined;
}

function projectXiaohongshu(
  row: ObjectValue,
  format: SocialDataProviderPlan["format"],
): SocialDataRecord {
  if (format === "xiaohongshu-user") {
    const id = string(row.userid);
    return {
      id,
      url: id
        ? sourceUrl(`https://www.xiaohongshu.com/user/profile/${id}`)
        : undefined,
      username: string(row.red_id),
      displayName: string(row.nickname),
      description: string(row.desc),
      followers: count(row.fans),
      following: count(row.follows),
      reactions: count(row.liked),
    };
  }
  if (format === "xiaohongshu-comment") {
    const replies = row.sub_comments;
    return {
      id: string(row.id),
      text: string(row.content),
      publishedAt: timestamp(row.time),
      username: string(nested(row, "user").nickname),
      likes: count(row.like_count),
      replies: Array.isArray(replies) ? replies.length : undefined,
    };
  }
  const id = string(row.id);
  return {
    id,
    url: xiaohongshuNoteUrl(id),
    title: string(row.title) ?? string(row.display_title),
    text: string(row.desc),
    // Search rows carry "timestamp", profile rows "create_time", note
    // details "time"; all are epoch seconds.
    publishedAt: timestamp(row.time ?? row.create_time ?? row.timestamp),
    username: string(nested(row, "user").nickname),
    likes: count(row.liked_count) ?? count(row.likes),
    comments: count(row.comments_count),
    shares: count(row.shared_count),
    reactions: count(row.collected_count),
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
      return projectInstagram(row, plan);
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
    case "xiaohongshu": {
      return projectXiaohongshu(row, plan.format);
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

/**
 * TikHub proxies each vendor API verbatim, so every endpoint nests its rows
 * differently. Returns null for Apify plans, which stay on the array shape.
 */
function tikhubOutputRows(
  plan: SocialDataProviderPlan,
  output: unknown,
): readonly unknown[] | null {
  if (plan.provider !== "tikhub") {
    return null;
  }
  switch (plan.format) {
    case "instagram-user": {
      const user = nested(nested(object(output), "data"), "user");
      if (plan.request.operation === "inspect") {
        return [user];
      }
      const feed = nested(
        user,
        plan.request.kind === "reels"
          ? "edge_felix_video_timeline"
          : "edge_owner_to_timeline_media",
      );
      if (!Array.isArray(feed.edges)) {
        return invalidOutput();
      }
      return feed.edges.map((edge: unknown) => {
        return nested(object(edge), "node");
      });
    }
    case "instagram-post": {
      return [object(output)];
    }
    case "instagram-comment": {
      const items = nested(object(output), "data").items;
      return Array.isArray(items) ? items : invalidOutput();
    }
    case "xiaohongshu-user": {
      return [nested(object(output), "data")];
    }
    case "xiaohongshu-comment": {
      const comments = nested(object(output), "data").comments;
      return Array.isArray(comments) ? comments : invalidOutput();
    }
    case "xiaohongshu-note": {
      const data = object(output).data;
      // Note details answer with a single-entry envelope wrapping note_list.
      if (Array.isArray(data)) {
        const notes = data.length === 1 ? object(data[0]).note_list : undefined;
        return Array.isArray(notes) ? notes : invalidOutput();
      }
      const payload = object(data);
      if (Array.isArray(payload.notes)) {
        return payload.notes;
      }
      if (Array.isArray(payload.items)) {
        return payload.items.map((item: unknown) => {
          return nested(object(item), "note");
        });
      }
      return invalidOutput();
    }
    default: {
      return null;
    }
  }
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
  const tikhubRows = tikhubOutputRows(plan, output);
  if (tikhubRows) {
    rows = tikhubRows;
  } else if (plan.format === "tiktok-comment") {
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

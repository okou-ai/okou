import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../../lib/env";
import { safeUrlParse, settle } from "../utils";

function parseXProfileHandle(profileUrl: string): string | null {
  const url = safeUrlParse(profileUrl);
  if (
    !url ||
    url.protocol !== "https:" ||
    !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
      url.hostname,
    )
  ) {
    return null;
  }
  const handle = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(url.pathname)?.[1];
  if (!handle || handle.toLowerCase() === "i") {
    return null;
  }
  return handle.toLowerCase();
}

/** Internal acquisition verification is paid by the platform, not the claimant. */
export async function readGetStartedRewardPost(
  url: string,
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "post";
      readonly id: string;
      readonly text: string;
      /** Lowercased author handle, or null when Router gave no usable profile URL. */
      readonly authorHandle: string | null;
    }
  | { readonly kind: "retry"; readonly reason: string }
> {
  const endpoint = env("OKOU_DATA_ROUTER_URL");
  const token = env("OKOU_DATA_TOKEN");
  if (!endpoint || !token) {
    return { kind: "retry", reason: "verification_unavailable" };
  }
  const fetched = await settle(
    fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Okou-Data-Request-Id": randomUUID(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name: "twitter_tweet", arguments: { url } },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    }),
  );
  signal.throwIfAborted();
  if (!fetched.ok) {
    if (
      fetched.error instanceof Error &&
      fetched.error.name === "TimeoutError"
    ) {
      return { kind: "retry", reason: "verification_timeout" };
    }
    throw fetched.error;
  }
  if (!fetched.value.ok) {
    return { kind: "retry", reason: "verification_unavailable" };
  }
  const response = z
    .object({
      result: z.object({
        structuredContent: z.object({
          data: z.object({
            status: z.literal(200),
            body: z.object({ result: z.object({ tweet: z.unknown() }) }),
          }),
        }),
      }),
    })
    .safeParse(await fetched.value.json());
  signal.throwIfAborted();
  if (!response.success) {
    return { kind: "retry", reason: "incomplete_response" };
  }
  const result = response.data.result.structuredContent.data.body;
  const tweet = z
    .object({
      id: z.string().min(1),
      text: z.string().min(1),
      author: z.unknown(),
    })
    .safeParse(result.result.tweet);
  if (!tweet.success || !tweet.data.text.trim()) {
    return { kind: "retry", reason: "incomplete_response" };
  }
  // A malformed author must not turn a readable post into a retry; the review
  // rejects a post whose author cannot be identified.
  const author = z
    .object({ profileUrl: z.string() })
    .safeParse(tweet.data.author);
  const profileUrl = author.success ? author.data.profileUrl : null;
  return {
    kind: "post",
    id: tweet.data.id,
    text: tweet.data.text,
    authorHandle: profileUrl ? parseXProfileHandle(profileUrl) : null,
  };
}

import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { literal, object, string, unknown as zUnknown } from "zod";
import { env } from "../../lib/env";
import { safeUrlParse, settle } from "../utils";
import { fetchDataRouter } from "./data-router-request";

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
    (async () => {
      const acceptedResponse = await settle(
        accept(
          fetchDataRouter(endpoint, token, {
            method: "tools/call",
            params: { name: "twitter_tweet", arguments: { url } },
          }),
          [200],
        ),
      );
      if (!acceptedResponse.ok) {
        const error = acceptedResponse.error;
        if (error instanceof HttpStatusError && error.status >= 300) {
          return error.response;
        }
        throw error;
      }
      return acceptedResponse.value;
    })(),
  );
  signal.throwIfAborted();
  if (!fetched.ok) {
    throw fetched.error;
  }
  if (!fetched.value.ok) {
    return { kind: "retry", reason: "verification_unavailable" };
  }
  const response = object({
    result: object({
      structuredContent: object({
        data: object({
          status: literal(200),
          body: object({ result: object({ tweet: zUnknown() }) }),
        }),
      }),
    }),
  }).safeParse(await fetched.value.json());
  signal.throwIfAborted();
  if (!response.success) {
    return { kind: "retry", reason: "incomplete_response" };
  }
  const result = response.data.result.structuredContent.data.body;
  const tweet = object({
    id: string().min(1),
    text: string().min(1),
    author: zUnknown(),
  }).safeParse(result.result.tweet);
  if (!tweet.success || !tweet.data.text.trim()) {
    return { kind: "retry", reason: "incomplete_response" };
  }
  // A malformed author must not turn a readable post into a retry; the review
  // rejects a post whose author cannot be identified.
  const author = object({ profileUrl: string() }).safeParse(tweet.data.author);
  const profileUrl = author.success ? author.data.profileUrl : null;
  return {
    kind: "post",
    id: tweet.data.id,
    text: tweet.data.text,
    authorHandle: profileUrl ? parseXProfileHandle(profileUrl) : null,
  };
}

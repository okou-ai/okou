import type { FeedItem } from "@okouai/api-contracts/contracts/feed";

export type FeedItemType = FeedItem["type"];
export type FeedItemContent = NonNullable<FeedItem["content"]>;
export type FeedItemState = FeedItem["state"];

/** Raw Discord attachment metadata retained only as server-private launch material. */
export interface ChatDiscordMessageFile {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly url: string;
  readonly proxy_url?: string;
  readonly content_type?: string;
  readonly description?: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly ephemeral?: boolean;
}

export type ChatDiscordMessageFiles = readonly ChatDiscordMessageFile[];

/** Canonical input asset paired to its upstream Discord attachment. */
export interface ChatDiscordMessageAsset {
  readonly assetId: string;
  readonly discordAttachmentId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly status: "pending" | "ready" | "failed";
}

export type ChatDiscordMessageAssets = readonly ChatDiscordMessageAsset[];

export type ChatDiscordMentionDisplayNames = Record<string, string>;

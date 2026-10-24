import type { SocialDataCreateRequest } from "@okouai/api-contracts/contracts/social-data";

export type SocialDataJobRequest = SocialDataCreateRequest;

/** Historical persisted results; the Router owns new execution results. */
interface SocialDataJobRecord {
  readonly id?: string;
  readonly url?: string;
  readonly text?: string;
  readonly title?: string;
  readonly description?: string;
  readonly publishedAt?: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly parentId?: string;
  readonly authorId?: string;
  readonly authorUrl?: string;
  readonly followers?: number;
  readonly following?: number;
  readonly posts?: number;
  readonly views?: number;
  readonly likes?: number;
  readonly reactions?: number;
  readonly comments?: number;
  readonly shares?: number;
  readonly replies?: number;
  readonly duration?: number;
  readonly mediaUrls?: string[];
}

export type SocialDataJobResult =
  | { items: SocialDataJobRecord[]; pagination?: { hasMore: boolean | null } }
  | {
      transcript: string;
      segments?: { text: string; start?: number; duration?: number }[];
      language?: string;
    };

export type SocialDataJobProviderCursor =
  | { kind: "douyin-cursor"; value: number }
  | { kind: "douyin-max-cursor"; value: number }
  | { kind: "douyin-max-time"; value: string; sourceType?: 1 }
  | { kind: "weibo-page"; value: number }
  | { kind: "weibo-max-id"; value: string };

/** Immutable collection bound and delivered identities, updated once per completed page. */
export interface SocialDataJobCollectionProgress {
  readonly rootJobId: string;
  readonly totalLimit: number;
  readonly deliveredCount: number;
  readonly seenKeys: readonly string[];
  readonly hasMore: boolean | null;
}

export interface SocialDataJobError {
  readonly code: string;
  readonly message: string;
}

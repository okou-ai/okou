import type {
  SocialDataCreateRequest,
  SocialDataResult,
  SocialDataProviderCursor,
} from "@okouai/api-contracts/contracts/social-data";

export type SocialDataJobRequest = SocialDataCreateRequest;
export type SocialDataJobResult = SocialDataResult;
export type SocialDataJobProviderCursor = SocialDataProviderCursor;

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

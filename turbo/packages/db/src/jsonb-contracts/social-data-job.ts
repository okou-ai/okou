import type {
  SocialDataCreateRequest,
  SocialDataResult,
} from "@okouai/api-contracts/contracts/social-data";

export type SocialDataJobRequest = SocialDataCreateRequest;
export type SocialDataJobResult = SocialDataResult;

export interface SocialDataJobError {
  readonly code: string;
  readonly message: string;
}

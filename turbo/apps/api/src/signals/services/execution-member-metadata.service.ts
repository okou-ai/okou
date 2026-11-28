import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { PresentationOutputFormat } from "@okouai/api-contracts/validators/presentation-output-format";

export interface ExecutionMemberIdentity {
  readonly orgId: string;
  readonly userId: string;
}

export interface ExecutionUserProfile {
  readonly name: string | null;
  readonly email: string | null;
}

export interface ExecutionMemberPreferences {
  readonly timezone: string | null;
  readonly selectedImageModel: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: string | null;
  readonly modelSettings: ModelSettings;
  readonly cloudBrowserEnabledByDefault: boolean;
  readonly presentationFormat: PresentationOutputFormat | null;
}

export interface ExecutionMemberMetadata {
  readonly profile: ExecutionUserProfile | null;
  readonly preferences: ExecutionMemberPreferences | null;
}

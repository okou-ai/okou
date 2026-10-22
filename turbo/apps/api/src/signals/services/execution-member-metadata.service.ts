import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";

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
}

export interface ExecutionMemberMetadata {
  readonly profile: ExecutionUserProfile | null;
  readonly preferences: ExecutionMemberPreferences | null;
}

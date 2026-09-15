import type { JsonObject } from "./shared";

export type RunUploadedFileMetadata = JsonObject;

export type CanonicalAssetProvenance =
  | {
      readonly provider:
        | "feishu"
        | "lark"
        | "teams"
        | "telegram"
        | "agentphone";
      readonly installationId: string;
      readonly messageId: string;
      readonly externalFileId: string;
    }
  | {
      readonly provider: "slack";
      readonly workspaceId: string;
      readonly channelId: string;
      readonly messageTs?: string;
      readonly externalFileId: string;
    }
  | {
      readonly provider: "agent";
    };

export interface CanonicalAssetMaterializationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface CanonicalAssetSlackDeliveryDestination {
  readonly channelId: string;
  readonly threadTs?: string;
  readonly title?: string;
  readonly initialComment?: string;
}

export interface CanonicalAssetDeliveryError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

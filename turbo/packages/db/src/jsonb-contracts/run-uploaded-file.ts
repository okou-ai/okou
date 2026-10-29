import type { JsonObject } from "./shared";

export type RunUploadedFileMetadata = JsonObject;

export type CanonicalAssetProvenance =
  | {
      readonly provider:
        "feishu" | "lark" | "teams" | "telegram" | "agentphone" | "wechat";
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
      readonly provider: "discord";
      readonly guildId: string | null;
      readonly channelId: string;
      readonly messageId: string;
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
  readonly provider?: never;
  /** Installation selected at publication; omitted by pre-identity writers. */
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly threadTs?: string;
  readonly title?: string;
  readonly initialComment?: string;
}

export interface CanonicalAssetDiscordDeliveryDestination {
  readonly provider: "discord";
  readonly connectionId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly comment?: string;
}

export type CanonicalAssetDeliveryDestination =
  | CanonicalAssetSlackDeliveryDestination
  | CanonicalAssetDiscordDeliveryDestination
  | CanonicalAssetWechatDeliveryDestination
  | CanonicalAssetTeamsDeliveryDestination;

export interface CanonicalAssetDiscordDeliveryState {
  readonly provider: "discord";
  readonly attempt: {
    readonly id: string;
    readonly startedAt: string;
  } | null;
  readonly attachmentId?: string;
}

export interface CanonicalAssetDeliveryError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface CanonicalAssetWechatDeliveryDestination {
  readonly provider: "wechat";
  readonly connectionId: string;
  readonly generation: string;
  readonly channelId: string;
  readonly comment?: string;
}
export interface CanonicalAssetWechatDeliveryState {
  readonly provider: "wechat";
  readonly attempt: { readonly id: string; readonly startedAt: string } | null;
}

export type CanonicalAssetDeliveryProviderState =
  | CanonicalAssetDiscordDeliveryState
  | CanonicalAssetWechatDeliveryState
  | CanonicalAssetTeamsDeliveryState;

export interface CanonicalAssetTeamsDeliveryDestination {
  readonly provider: "teams";
  readonly tenantId: string;
  readonly conversationId: string;
  readonly source: boolean;
  readonly activityId?: string;
  readonly text?: string;
}

export interface CanonicalAssetTeamsDeliveryState {
  readonly provider: "teams";
  readonly attempt: { readonly id: string; readonly startedAt: string } | null;
}

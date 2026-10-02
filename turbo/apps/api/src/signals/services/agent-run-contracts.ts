import type { ModelProviderCredentialScope } from "@okouai/api-contracts/contracts/model-providers";
import type { InternalRunCallbackKind } from "./internal-run-callback";

export interface AgentRunModelPin {
  readonly modelProvider: string | null;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

export interface HttpRunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

export interface InternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

export type RunCallback = HttpRunCallback | InternalRunCallback;

export type AgentRunPreCreateSource =
  | "chat_callback_auto_send"
  | "workflow_slash_command";

export interface AgentRunRequestAgent {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
  readonly defaultAgentId: string | null;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
}

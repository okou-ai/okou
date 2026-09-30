import type { ModelProviderCredentialScope } from "@okouai/api-contracts/contracts/model-providers";
import type { Command } from "ccstate";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
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

export interface DispatchFailedRunCallbackInput {
  readonly db: Db;
  readonly runId: string;
  readonly error: string;
  readonly callbacks: readonly RunCallback[];
}

export type DispatchFailedRunCallbacks = Command<
  Promise<void>,
  [DispatchFailedRunCallbackInput, AbortSignal]
>;

/**
 * A producer write committed with the run insert, before terminal callbacks.
 * Lost claims and rolled-back launches leave no producer binding. This callback
 * is in memory only and is never serialized into run metadata.
 */
export type PersistProducerRunBinding = (
  tx: Tx,
  run: { readonly runId: string; readonly status: "pending" | "failed" },
) => Promise<void>;

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

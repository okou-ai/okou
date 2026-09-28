import type {
  ChatRunOptionsRequest,
  ChatThreadServiceTier,
  CodexServiceTier,
  UserMessageDocument,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

/**
 * Mirror the server-owned run-model annotation in the client projection. The
 * separate model and run-options request fields remain authoritative; the
 * server replaces this annotation with the selection resolved for the run.
 */
export function withSelectedModelAnnotation(
  document: UserMessageInputDocument,
  selectedModel: string | null | undefined,
  serviceTier?: ChatThreadServiceTier,
): UserMessageDocument {
  if (selectedModel === null || selectedModel === undefined) {
    return document;
  }
  return {
    version: 1,
    parts: [
      ...document.parts,
      {
        type: "model",
        selectedModel,
        ...(serviceTier === undefined ? {} : { serviceTier }),
      },
    ],
  };
}

/**
 * Run options travel with one message and are never persisted, which is what
 * makes this the channel for the Codex tier: it is not a property of the
 * thread.
 */
export function runOptionsFromModelProviderSelection(
  value: ModelProviderSelection | null,
): ChatRunOptionsRequest | undefined {
  return value?.codexServiceTier === "fast"
    ? { codexServiceTier: "fast" }
    : undefined;
}

export function threadCodexServiceTierFromSelection(
  value: ModelProviderSelection | null,
): CodexServiceTier | null {
  return value?.codexServiceTier === "fast" ? "fast" : null;
}

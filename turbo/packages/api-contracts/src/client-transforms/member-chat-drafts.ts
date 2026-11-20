import { agentDraftContract } from "../contracts/agent-draft";
import { chatThreadDraftContract } from "../contracts/chat-threads";
import { composerDraftSchema } from "../validators/chat-threads";
import type { ClientResponseTransform } from "./types";

// Older native readers require an Agent UUID on Run references. Keep the
// reference label and link readable without inventing an Agent identity.
function legacyDraft(body: unknown) {
  const draft = composerDraftSchema.parse(body);
  const message = draft.draftUserMessage;
  if (!message) return draft;
  return {
    ...draft,
    draftUserMessage: {
      ...message,
      parts: message.parts.map((part) => {
        return part.type === "source" && part.kind === "agent" && !part.agentId
          ? { type: "text", text: `${part.titleSnapshot} (${part.href})` }
          : part;
      }),
    },
  };
}

function draftTransforms(path: string): ClientResponseTransform[] {
  return (["ios", "android"] as const).map((client) => {
    return {
      client,
      maxVersion: client === "ios" ? "0.51.5" : "0.32.4",
      since: "#49637",
      method: "GET",
      path,
      status: 200,
      transform: legacyDraft,
    };
  });
}

export const legacyAgentDraftTransforms = draftTransforms(
  agentDraftContract.get.path,
);
export const legacyThreadDraftTransforms = draftTransforms(
  chatThreadDraftContract.get.path,
);

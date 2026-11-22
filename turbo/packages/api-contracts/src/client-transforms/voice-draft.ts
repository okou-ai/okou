import { composerDraftContract } from "../contracts/agent-draft";
import {
  chatThreadDraftContract,
  type UserMessageInputPart,
} from "../contracts/chat-threads";
import { composerDraftSchema } from "../validators/chat-threads";
import type { ClientResponseTransform } from "./types";

/** Older native composers understand file attachments. Keep each clip available in order. */
function legacyVoiceDraft(body: unknown) {
  const draft = composerDraftSchema.parse(body);
  const message = draft.draftUserMessage;
  if (!message) {
    return draft;
  }
  const parts = message.parts.flatMap<UserMessageInputPart>((part) => {
    if (part.type !== "voice") {
      return [part];
    }
    return part.clips.map(({ fileId }, index) => {
      const attachment = draft.draftAttachments?.find((item) => {
        return item.id === fileId;
      });
      return {
        type: "file" as const,
        fileId,
        filenameSnapshot:
          attachment?.filename ?? `Voice clip ${String(index + 1)}`,
        contentType: attachment?.contentType ?? "audio/*",
      };
    });
  });
  return { ...draft, draftUserMessage: { ...message, parts } };
}

function draftTransforms(client: ClientResponseTransform["client"]) {
  const common = {
    client,
    method: "GET",
    status: 200,
    maxVersion: null,
    since: "#49901",
    transform: legacyVoiceDraft,
  } as const;
  return {
    composer: { ...common, path: composerDraftContract.get.path },
    thread: { ...common, path: chatThreadDraftContract.get.path },
  };
}

export const iosVoiceDraftTransforms = draftTransforms("ios");
export const androidVoiceDraftTransforms = draftTransforms("android");

import { command } from "ccstate";
import type { ResolvedAttachFile } from "@okouai/api-contracts/contracts/chat-threads";
import type { DraftSignals, ChatAttachment } from "../okou-page/chat-draft.ts";
import { i18n } from "../../i18n/index.ts";
import { isAnnotationMeaningful } from "../okou-page/image-annotation.ts";

/**
 * Placeholder stored as the prompt when the user sends only files with no
 * typed text, so the `chatEventsContract.send` body passes its `min(1)`
 * validation. The UI strips this placeholder from `PagedUserMessage` so the
 * bubble shows only the download chips.
 */
const ATTACH_ONLY_PLACEHOLDER = "(see attached files)";

/**
 * Prepared send-message payload derived from a draft.
 *
 * - `prompt` — clean text (or `ATTACH_ONLY_PLACEHOLDER` for file-only sends).
 * - `attachments` — upload metadata used only to build canonical file parts.
 * - `hasTextContent` — whether the user typed any non-whitespace text;
 *   used by the server to decide prompt-only vs. attachment-only rendering.
 */
interface PreparedUserMessage {
  prompt: string;
  attachments: ResolvedAttachFile[] | undefined;
  hasTextContent: boolean;
}

interface AttachmentFileInfo {
  id: string;
  url: string;
  contentType: string;
}

interface ResolvedDraftAttachment {
  attachment: ChatAttachment;
  info: AttachmentFileInfo;
}

export function collectSuccessfulAttachmentInfos(
  attachments: readonly ChatAttachment[],
  results: readonly PromiseSettledResult<AttachmentFileInfo | null>[],
): ResolvedDraftAttachment[] {
  return results.flatMap((result, index) => {
    const attachment = attachments[index];
    if (!attachment || result.status !== "fulfilled" || result.value === null) {
      return [];
    }

    return [{ attachment, info: result.value }];
  });
}

/**
 * Resolves a draft's pending attachments (waits for uploads to finish,
 * omits failed entries) and shapes the result into
 * canonical file parts for the outbound user-message document.
 *
 * Returns `null` when the user has typed nothing and no attachments are
 * ready — callers should abort the send in that case.
 *
 * Shared by `sendMessage$` (in-thread follow-ups) and `sendNewThreadMessage$`
 * (first message on a new thread) so both entry points produce identical
 * request bodies.
 */
export const prepareUserMessageFromDraft$ = command(
  async (
    { get },
    draft: DraftSignals,
    prompt: string,
    signal: AbortSignal,
  ): Promise<PreparedUserMessage | null> => {
    const allAttachments = get(draft.attachments$);
    const allInfos = await Promise.allSettled(
      allAttachments.map((a) => {
        return get(a.fileInfo$);
      }),
    );
    signal.throwIfAborted();

    const ready = collectSuccessfulAttachmentInfos(allAttachments, allInfos);

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt && ready.length === 0) {
      return null;
    }

    // User prompt is clean text only — file description blocks are appended
    // server-side via buildFullPrompt so the agent gets the [Web file] [ID]
    // format it knows how to download with `okou web download-file`.
    const finalPrompt = trimmedPrompt || ATTACH_ONLY_PLACEHOLDER;

    const attachments: ResolvedAttachFile[] | undefined =
      ready.length > 0
        ? ready.map((r) => {
            const annotations = get(r.attachment.annotations$);
            const annotatedFileId = get(r.attachment.annotatedFileId$);
            if (isAnnotationMeaningful(annotations) && !annotatedFileId) {
              throw new Error(
                i18n.t(
                  ($) => {
                    return $.chat.attachments.uploadFailed;
                  },
                  { filename: r.attachment.filename },
                ),
              );
            }
            return {
              id: r.info.id,
              filename: r.attachment.filename,
              contentType: r.info.contentType,
              size: r.attachment.size,
              url: r.info.url,
              ...(annotatedFileId ? { annotatedFileId } : {}),
              ...(annotations ? { annotations } : {}),
            };
          })
        : undefined;

    return {
      prompt: finalPrompt,
      attachments,
      hasTextContent: trimmedPrompt.length > 0,
    };
  },
);

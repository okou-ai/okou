import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { publicAttachmentUrl } from "../views/okou-page/attachment-url.ts";
import { writeToClipboard } from "./okou-page/clipboard.ts";
import { resetSignal, scheduleTimeout } from "./utils.ts";

// The same two seconds the shared CopyButton confirms for.
const COPIED_CONFIRMATION_MS = 2000;

/**
 * Copy link inside a share menu confirms on the button the user just pressed,
 * so a successful copy reads "Copied" there instead of raising a toast. A
 * failed copy changes nothing on the button, so it still toasts.
 *
 * The confirmation names the URL it copied: once the menu offers a different
 * link, or `clear$` runs, the button offers to copy again.
 */
export function createShareLinkCopy() {
  const internalCopiedUrl$ = state<string | null>(null);
  const resetCopy$ = resetSignal();
  const copiedUrl$ = computed((get) => {
    return get(internalCopiedUrl$);
  });
  const clear$ = command(({ set }) => {
    set(resetCopy$);
    set(internalCopiedUrl$, null);
  });
  const confirm$ = command(
    async ({ set }, url: string, signal: AbortSignal) => {
      const copied = await writeToClipboard(publicAttachmentUrl(url));
      signal.throwIfAborted();
      if (!copied) {
        toast.error(
          i18n.t(($) => {
            return $.artifacts.toasts.copyLinkFailed;
          }),
        );
        return;
      }
      set(internalCopiedUrl$, url);
      // Confirmation must not keep the save operation busy for two seconds.
      scheduleTimeout(
        () => {
          set(internalCopiedUrl$, null);
        },
        COPIED_CONFIRMATION_MS,
        signal,
      );
    },
  );
  // A second copy restarts the confirmation instead of racing the first one.
  const copy$ = command(({ set }, url: string, signal: AbortSignal) => {
    set(internalCopiedUrl$, null);
    return set(confirm$, url, set(resetCopy$, signal));
  });
  return { copiedUrl$, clear$, copy$ };
}

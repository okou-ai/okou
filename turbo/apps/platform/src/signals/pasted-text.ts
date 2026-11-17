import { command, state } from "ccstate";
import { i18n } from "../i18n/index.ts";

const PASTED_TEXT_ATTACHMENT_THRESHOLD = 10_000;
const pastedTextSequence$ = state(0);

/** Count UTF-16 code units, matching the prompt contract's string validation. */
export const pastedTextFile$ = command(
  ({ get, set }, text: string, hasFileItems: boolean): File | null => {
    if (hasFileItems || text.length <= PASTED_TEXT_ATTACHMENT_THRESHOLD) {
      return null;
    }
    const sequence = get(pastedTextSequence$) + 1;
    set(pastedTextSequence$, sequence);
    const label = i18n.t(($) => {
      return $.chat.attachments.pastedText;
    });
    return new File([text], `${label}-${sequence}.txt`, {
      type: "text/plain",
    });
  },
);

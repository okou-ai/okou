import { computed } from "ccstate";

import {
  createMailDraftSignals,
  parseMailDraftUrl,
} from "../chat-page/mail-draft.ts";
import { pathParams$ } from "../route.ts";

export const mailDraftPageSignals$ = computed((get) => {
  const mailDraftId = String(get(pathParams$)?.mailDraftId ?? "");
  const descriptor = parseMailDraftUrl(`/mail/drafts/${mailDraftId}`);
  return descriptor ? createMailDraftSignals(descriptor) : null;
});

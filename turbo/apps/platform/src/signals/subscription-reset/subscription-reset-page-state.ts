import { computed } from "ccstate";

import { pathParams$, searchParams$ } from "../route.ts";
import {
  createSubscriptionResetSignals,
  parseSubscriptionResetUrl,
} from "../chat-page/subscription-reset-block.ts";

export const subscriptionResetPageSignals$ = computed((get) => {
  const id = String(get(pathParams$)?.subscriptionId ?? "");
  const query = get(searchParams$).toString();
  const result = parseSubscriptionResetUrl(
    `/subscriptions/${encodeURIComponent(id)}/reset?${query}`,
  );
  return result.status === "valid"
    ? createSubscriptionResetSignals(result.descriptor)
    : null;
});

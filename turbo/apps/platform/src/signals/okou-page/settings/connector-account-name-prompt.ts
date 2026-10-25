import { computed } from "ccstate";
import { managedConnectorAccessSlug$ } from "./connector-access-management.ts";
import {
  builtinAccountConnectDialog$,
  builtinAccountManager$,
  connectorAccountNamePrompt$,
} from "./connector-account-dialogs.ts";
import { builtinConnectorScopeReviewSelection$ } from "./connectors.ts";

export const visibleConnectorAccountNamePrompt$ = computed((get) => {
  // Keep the name prompt queued until the current account dialog closes.
  if (
    get(builtinAccountManager$) ||
    get(builtinAccountConnectDialog$) ||
    get(managedConnectorAccessSlug$) ||
    get(builtinConnectorScopeReviewSelection$)
  ) {
    return null;
  }
  return get(connectorAccountNamePrompt$);
});

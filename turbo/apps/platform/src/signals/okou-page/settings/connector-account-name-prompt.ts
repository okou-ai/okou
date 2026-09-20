import { computed } from "ccstate";
import { connectorConnectionPending$ } from "../../connector-connection-progress.ts";
import { managedConnectorAccessSlug$ } from "./connector-access-management.ts";
import {
  builtinAccountConnectDialog$,
  builtinAccountManager$,
  connectorAccountNamePrompt$,
  customAccountConnectDialog$,
  customAccountManager$,
} from "./connector-account-dialogs.ts";
import { builtinConnectorScopeReviewSelection$ } from "./connectors.ts";
import {
  connectorsPageTab$,
  customConnectorDialog$,
} from "./custom-connectors.ts";

export const visibleConnectorAccountNamePrompt$ = computed((get) => {
  // A background connection must not interrupt another dialog. Keep its name
  // prompt queued until connection cleanup and the current dialog finish.
  if (
    get(connectorConnectionPending$) ||
    get(builtinAccountManager$) ||
    get(builtinAccountConnectDialog$) ||
    get(managedConnectorAccessSlug$) ||
    get(builtinConnectorScopeReviewSelection$) ||
    (get(connectorsPageTab$) === "custom" &&
      (get(customAccountManager$) ||
        get(customAccountConnectDialog$) ||
        get(customConnectorDialog$).kind !== "none"))
  ) {
    return null;
  }
  return get(connectorAccountNamePrompt$);
});

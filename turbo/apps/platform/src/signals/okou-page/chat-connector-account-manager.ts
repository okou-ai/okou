import { command, computed, state } from "ccstate";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorByIdContract } from "@okouai/api-contracts/client/custom-connectors";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  loadConnectorCatalogItem$,
  subscribeBuiltinConnectorChanges$,
} from "../external/connectors.ts";
import { resetSignal } from "../utils.ts";
import {
  builtinAccountManager$,
  builtinAccountConnectDialog$,
  customAccountConnectDialog$,
  connectorAccountNamePrompt$,
  customAccountManager$,
  openBuiltinAccountManager$,
  openCustomAccountManager$,
  resetConnectorAccountDialogs$,
} from "./settings/connector-account-dialogs.ts";
import {
  builtinConnectorScopeReviewSelection$,
  setBuiltinConnectorScopeReviewSelection$,
} from "./settings/connectors.ts";

// The account dialogs are shared, so opening from another composer transfers
// their lifetime and releases the previous composer's dialog host.
const resetActiveAccountManager$ = resetSignal();

/** Account management stays on the Chat and shares its composer's lifetime. */
export function createChatConnectorAccountManagerSignals() {
  const active$ = state(false);
  const resetOwner$ = resetSignal();
  const open$ = command(
    async (
      { get, set },
      target: ConnectorAccountTarget,
      parentSignal: AbortSignal,
    ) => {
      parentSignal.throwIfAborted();
      const ownerSignal = set(resetOwner$, parentSignal);
      const signal = set(resetActiveAccountManager$, ownerSignal);
      set(resetConnectorAccountDialogs$);
      set(setBuiltinConnectorScopeReviewSelection$, null);
      signal.addEventListener(
        "abort",
        () => {
          set(resetConnectorAccountDialogs$);
          set(setBuiltinConnectorScopeReviewSelection$, null);
          set(active$, false);
        },
        { once: true },
      );
      if (target.kind === "builtin") {
        const connector = await set(
          loadConnectorCatalogItem$,
          target.connectorSlug,
          signal,
        );
        if (!connector) {
          toast.error(
            i18n.t(($) => {
              return $.connectors.accounts.accountsUnavailable;
            }),
          );
          return false;
        }
        set(openBuiltinAccountManager$, connector, signal);
      } else {
        const result = await accept(
          get(apiClient$)(customConnectorByIdContract).get({
            params: { id: target.customConnectorId },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        set(openCustomAccountManager$, result.body, signal);
      }
      set(subscribeBuiltinConnectorChanges$, signal);
      set(active$, true);
      return true;
    },
  );
  return {
    open$,
    finalFocus$: command(({ get }, element: HTMLElement | null) => {
      // A connection or scope-review dialog owns focus during an account handoff.
      if (
        get(builtinAccountConnectDialog$) ||
        get(customAccountConnectDialog$) ||
        get(builtinConnectorScopeReviewSelection$) ||
        get(connectorAccountNamePrompt$)
      ) {
        return false;
      }
      return element?.isConnected ? element : false;
    }),
    close$: command(({ set }) => {
      set(resetOwner$);
    }),
    active$: computed((get) => {
      return get(active$);
    }),
    managerOpen$: computed((get) => {
      return (
        get(active$) &&
        Boolean(get(builtinAccountManager$) || get(customAccountManager$))
      );
    }),
  };
}

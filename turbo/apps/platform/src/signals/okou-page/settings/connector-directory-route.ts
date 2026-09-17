import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { pathname$, searchParams$, updateSearchParams$ } from "../../route.ts";
import { onRef } from "../../utils.ts";

export const connectorDirectoryEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ConnectorDirectory] === true;
});

/**
 * Which list the connectors page is showing. The three are different tasks --
 * finding something that talks to Shopify, checking who can use Gmail, and
 * maintaining what this workspace built -- and each is organised by a different
 * dimension, so one toolbar cannot serve them. Discovery is the default because
 * that is what a visit is usually for.
 *
 * The names are the ones a reader can check against the cards underneath:
 * every card under `connected` carries an account, and every card under
 * `custom` was authored here.
 */
export type ConnectorsScope = "discover" | "connected" | "custom";

const CONNECTORS_SCOPE_PARAM = "scope";

export const connectorsScope$ = computed((get): ConnectorsScope => {
  // Only the directory offers the control that sets this, so without it the
  // page has one list and one scope.
  if (!get(connectorDirectoryEnabled$)) {
    return "discover";
  }
  const raw = get(searchParams$).get(CONNECTORS_SCOPE_PARAM);
  return raw === "connected" || raw === "custom" ? raw : "discover";
});

/** Custom is a scope of its own rather than a destination inside the catalog. */
export const connectorDirectoryCustomScope$ = computed((get) => {
  return get(connectorsScope$) === "custom";
});

export const setConnectorsScope$ = command(
  ({ get, set }, value: ConnectorsScope) => {
    const params = new URLSearchParams(get(searchParams$));
    if (value === "discover") {
      params.delete(CONNECTORS_SCOPE_PARAM);
    } else {
      params.set(CONNECTORS_SCOPE_PARAM, value);
    }
    // Every other control belongs to the scope that was just left: a category
    // means nothing among the connectors you already have, and an agent means
    // nothing in a catalog of four thousand.
    params.delete("keywords");
    params.delete("category");
    params.delete("connection");
    set(updateSearchParams$, params);
  },
);

type DirectoryScope =
  | { readonly kind: "all" }
  | { readonly kind: "custom" }
  | { readonly kind: "category"; readonly category: string };

const createdConnectorId$ = state<string | null>(null);

export const openConnectorDirectoryScope$ = command(
  ({ get, set }, scope: DirectoryScope) => {
    const params = new URLSearchParams(get(searchParams$));
    params.delete("connection");
    params.delete(CONNECTORS_SCOPE_PARAM);
    params.delete("category");
    if (scope.kind === "custom") {
      params.set(CONNECTORS_SCOPE_PARAM, "custom");
    } else if (scope.kind === "category") {
      params.set("category", scope.category);
    }
    set(createdConnectorId$, null);
    set(updateSearchParams$, params);
  },
);

export const showCreatedDirectoryConnector$ = command(
  ({ get, set }, connectorId: string) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(CONNECTORS_SCOPE_PARAM, "custom");
    params.delete("category");
    params.delete("keywords");
    params.delete("connection");
    set(createdConnectorId$, connectorId);
    set(updateSearchParams$, params);
  },
);

export const focusCreatedDirectoryConnector$ = onRef(
  command(({ get, set }, element: HTMLDivElement, _signal: AbortSignal) => {
    if (
      get(connectorDirectoryEnabled$) &&
      get(pathname$) === "/connectors" &&
      element.dataset.customConnectorId === get(createdConnectorId$)
    ) {
      element.scrollIntoView({ block: "nearest" });
      element.focus({ preventScroll: true });
      set(createdConnectorId$, null);
    }
  }),
);

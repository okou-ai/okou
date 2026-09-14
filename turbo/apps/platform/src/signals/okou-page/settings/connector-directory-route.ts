import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { pathname$, searchParams$, updateSearchParams$ } from "../../route.ts";
import { onRef } from "../../utils.ts";
import { builtinConnectorMcpEnabled$ } from "../../external/connectors.ts";

export const builtinConnectorProtocol$ = computed((get): "http" | "mcp" => {
  return get(builtinConnectorMcpEnabled$) &&
    get(searchParams$).get("protocol") === "mcp"
    ? "mcp"
    : "http";
});

export const setBuiltinConnectorProtocol$ = command(
  ({ get, set }, protocol: "http" | "mcp") => {
    const params = new URLSearchParams(get(searchParams$));
    params.set("protocol", protocol);
    params.delete("keywords");
    params.delete("category");
    set(updateSearchParams$, params);
  },
);

export const connectorDirectoryEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ConnectorDirectory] === true;
});

export const connectorDirectoryCustomScope$ = computed((get) => {
  return (
    get(connectorDirectoryEnabled$) &&
    get(searchParams$).get("tab") === "custom"
  );
});

/**
 * Which of the two lists the connectors page is showing. They are different
 * tasks -- checking who can use Gmail, and finding something that talks to
 * Shopify -- and each is organised by a different dimension, so a single
 * toolbar cannot serve both. Discovery is the default because that is what a
 * visit is usually for.
 */
export type ConnectorsScope = "discover" | "mine";

const CONNECTORS_SCOPE_PARAM = "scope";

export const connectorsScope$ = computed((get): ConnectorsScope => {
  // Only the directory offers the control that sets this, so without it the
  // page has one list and one scope.
  if (!get(connectorDirectoryEnabled$)) {
    return "discover";
  }
  return get(searchParams$).get(CONNECTORS_SCOPE_PARAM) === "mine"
    ? "mine"
    : "discover";
});

export const setConnectorsScope$ = command(
  ({ get, set }, value: ConnectorsScope) => {
    const params = new URLSearchParams(get(searchParams$));
    if (value === "mine") {
      params.set(CONNECTORS_SCOPE_PARAM, value);
    } else {
      params.delete(CONNECTORS_SCOPE_PARAM);
    }
    // Every other control belongs to the scope that was just left: a category
    // means nothing among the connectors you already have, and an agent means
    // nothing in a catalog of four thousand.
    params.delete("keywords");
    params.delete("category");
    params.delete("connection");
    params.delete("tab");
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
    params.delete("tab");
    params.delete("category");
    if (scope.kind === "custom") {
      params.set("tab", "custom");
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
    params.set("tab", "custom");
    params.delete("category");
    params.delete("keywords");
    params.delete("connection");
    params.delete(CONNECTORS_SCOPE_PARAM);
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

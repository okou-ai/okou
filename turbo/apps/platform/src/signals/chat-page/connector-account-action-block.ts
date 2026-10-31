import {
  connectorAccountSelectionSchema,
  connectorAccountTargetKey,
} from "@okouai/api-contracts/validators/connector-accounts";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/client/chat-threads";
import { command, computed, type Command, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { connectorCatalogItemBySlug } from "../external/connectors.ts";
import type {
  ComposerConnectorAuthorizationState,
  ComposerConnectorSignals,
} from "../okou-page/connectors.ts";
import { customConnectors$ } from "../okou-page/settings/custom-connectors.ts";
import {
  chatActionCallbackFromUrl,
  runChatActionCallback$,
} from "./action-callback.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
  type ChatActionParseResult,
} from "./chat-action-context.ts";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";

export interface ConnectorAccountActionDescriptor {
  readonly agentId: string;
  readonly selection: ConnectorAccountSelection;
  readonly originalUrl: string;
  readonly callbackPrompt: string;
  readonly threadId: string;
}

type ConnectorAccountActionConnector =
  | {
      readonly kind: "builtin";
      readonly icon: PublicConnectorCatalogIcon | undefined;
    }
  | {
      readonly kind: "custom";
      readonly id: string;
      readonly displayName: string | null;
    };

export type ConnectorAccountActionStatus =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly account: ConnectorAccountConnection;
      readonly selected: boolean;
    };

export interface ConnectorAccountActionSignals extends ConnectorAccountActionDescriptor {
  readonly status$: Computed<Promise<ConnectorAccountActionStatus>>;
  readonly connector$: Computed<Promise<ConnectorAccountActionConnector>>;
  readonly confirm$: Command<Promise<void>, [AbortSignal]>;
}

type ConnectorAccountActionCardSignalsRegistry = CardSignalsRegistry<
  ConnectorAccountActionDescriptor,
  ConnectorAccountActionSignals
>;

export function connectorAccountActionResourceKey(
  descriptor: ConnectorAccountActionDescriptor,
): string {
  const path = `/agents/${encodeURIComponent(descriptor.agentId.toLowerCase())}/connector-accounts/${encodeURIComponent(descriptor.selection.connectionId.toLowerCase())}/select`;
  const targetKey = connectorAccountTargetKey(descriptor.selection.target);
  const params = new URLSearchParams({
    target:
      descriptor.selection.target.kind === "custom"
        ? targetKey.toLowerCase()
        : targetKey,
    threadId: descriptor.threadId.toLowerCase(),
    callbackPrompt: descriptor.callbackPrompt,
  });
  return `${path}?${params.toString()}`;
}

function selectionFromUrl(
  url: URL,
  connectionId: string,
): ConnectorAccountSelection | null {
  const kind = url.searchParams.get("kind");
  const connectorSlug = url.searchParams.get("connectorSlug");
  const customConnectorId = url.searchParams.get("customConnectorId");
  const target =
    kind === "builtin" && connectorSlug && customConnectorId === null
      ? { kind, connectorSlug }
      : kind === "custom" && customConnectorId && connectorSlug === null
        ? { kind, customConnectorId: customConnectorId.toLowerCase() }
        : null;
  const parsed = connectorAccountSelectionSchema.safeParse({
    connectionId: connectionId.toLowerCase(),
    target,
  });
  return parsed.success ? parsed.data : null;
}

export function parseConnectorAccountActionUrl(
  value: string,
  context: ChatActionContext | undefined,
): ChatActionParseResult<ConnectorAccountActionDescriptor> {
  const url = parseTrustedPlatformUrl(value);
  if (!url) {
    return { status: "unrelated" };
  }
  const match = url.pathname.match(
    /^\/agents\/([^/]+)\/connector-accounts\/([^/]+)\/select$/u,
  );
  if (!match) {
    return { status: "unrelated" };
  }
  const agentId = match[1] ?? "";
  const connectionId = match[2] ?? "";
  const selection = selectionFromUrl(url, connectionId);
  const callback = context ? chatActionCallbackFromUrl(url, context) : null;
  if (
    !context ||
    !agentId ||
    !chatActionIdMatches(agentId, context.agentId) ||
    !selection ||
    !callback?.callbackPrompt ||
    !callback.threadId
  ) {
    return { status: "invalid", originalUrl: value };
  }
  return {
    status: "valid",
    descriptor: {
      agentId: context.agentId,
      selection,
      originalUrl: value,
      callbackPrompt: callback.callbackPrompt,
      threadId: callback.threadId,
    },
  };
}

function targetQuery(selection: ConnectorAccountSelection) {
  return selection.target.kind === "builtin"
    ? {
        kind: selection.target.kind,
        connectorSlug: selection.target.connectorSlug,
      }
    : {
        kind: selection.target.kind,
        customConnectorId: selection.target.customConnectorId,
      };
}

function selectionIsCurrent(
  current: readonly ConnectorAccountSelection[],
  requested: ConnectorAccountSelection,
): boolean {
  const targetKey = connectorAccountTargetKey(requested.target);
  return current.some((selection) => {
    return (
      connectorAccountTargetKey(selection.target) === targetKey &&
      selection.connectionId === requested.connectionId
    );
  });
}

function targetIsAuthorized(
  authorization: ComposerConnectorAuthorizationState,
  target: ConnectorAccountTarget,
): boolean {
  return target.kind === "builtin"
    ? authorization.enabledConnectorSlugs.includes(target.connectorSlug)
    : authorization.customConnectorIds.includes(target.customConnectorId);
}

// A block names one connector, so it reads that catalog entry rather than the
// whole catalog status.
function builtinActionConnector(
  connectorSlug: ConnectorSlug,
): Computed<Promise<ConnectorAccountActionConnector>> {
  const catalogItem$ = connectorCatalogItemBySlug(connectorSlug);
  return computed(async (get): Promise<ConnectorAccountActionConnector> => {
    return { kind: "builtin", icon: (await get(catalogItem$))?.icon };
  });
}

function customActionConnector(
  customConnectorId: string,
): Computed<Promise<ConnectorAccountActionConnector>> {
  return computed(async (get): Promise<ConnectorAccountActionConnector> => {
    return {
      kind: "custom",
      id: customConnectorId,
      displayName:
        (await get(customConnectors$)).find((candidate) => {
          return candidate.id === customConnectorId;
        })?.displayName ?? null,
    };
  });
}

function createConnectorAccountConfirmSignal(
  descriptor: ConnectorAccountActionDescriptor,
  status$: ConnectorAccountActionSignals["status$"],
): ConnectorAccountActionSignals["confirm$"] {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const status = await get(status$);
    signal.throwIfAborted();
    if (status.kind !== "ready" || status.selected) {
      return;
    }
    const callbackIds = {
      clientEventId: crypto.randomUUID(),
      chatThreadSortEventId: crypto.randomUUID(),
    };
    await accept(
      get(apiClient$)(chatThreadConnectorSelectionContract).update({
        params: { id: descriptor.threadId },
        body: descriptor.selection,
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    await set(
      runChatActionCallback$,
      {
        threadId: descriptor.threadId,
        agentId: descriptor.agentId,
        callbackPrompt: descriptor.callbackPrompt,
        callbackIds,
      },
      signal,
    );
  });
}

function createConnectorAccountActionSignals(
  descriptor: ConnectorAccountActionDescriptor,
  connector: ComposerConnectorSignals,
): ConnectorAccountActionSignals {
  const target = descriptor.selection.target;
  const connector$ =
    target.kind === "builtin"
      ? builtinActionConnector(target.connectorSlug)
      : customActionConnector(target.customConnectorId);
  const status$ = computed(
    async (get): Promise<ConnectorAccountActionStatus> => {
      const authorization = await get(connector.connectorAuthorization$);
      if (!targetIsAuthorized(authorization, descriptor.selection.target)) {
        return { kind: "unavailable" };
      }
      const result = await accept(
        get(apiClient$)(connectorAccountsContract).connection({
          params: { connectionId: descriptor.selection.connectionId },
          query: targetQuery(descriptor.selection),
        }),
        [200, 404],
      );
      if (result.status === 404) {
        return { kind: "unavailable" };
      }
      const preference = await get(connector.accounts.preferenceState$);
      return {
        kind: "ready",
        account: result.body,
        selected: selectionIsCurrent(
          preference.selections,
          descriptor.selection,
        ),
      };
    },
  );

  return {
    ...descriptor,
    status$,
    connector$,
    confirm$: createConnectorAccountConfirmSignal(descriptor, status$),
  };
}

export function createConnectorAccountActionCardSignalsRegistry(
  connector: ComposerConnectorSignals,
): ConnectorAccountActionCardSignalsRegistry {
  return createCardSignalsRegistry(
    connectorAccountActionResourceKey,
    (descriptor) => {
      return createConnectorAccountActionSignals(descriptor, connector);
    },
  );
}

import {
  connectorAccountSelectionSchema,
  connectorAccountTargetKey,
} from "@okouai/api-contracts/validators/connector-accounts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/client/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

import { runConnectorAccountsContract } from "@okouai/api-contracts/client/run-connector-accounts";

import { command, computed, type Command, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { connectorCatalogItemBySlug } from "../external/connectors.ts";
import type { ComposerConnectorSignals } from "../okou-page/connectors.ts";
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
    !context.agentId ||
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
  connector: ComposerConnectorSignals,
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

    signal.throwIfAborted();
    await accept(
      get(apiClient$)(runConnectorAccountsContract).approve({
        params: { threadId: descriptor.threadId },
        body: descriptor.selection,
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    set(connector.chatAccess.reload$);
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
  const accessRevision$ = connector.chatAccess.targetRevision(target);
  const status$ = computed(
    async (get): Promise<ConnectorAccountActionStatus> => {
      get(accessRevision$);
      const client = get(apiClient$);
      const [account, access] = await Promise.all([
        accept(
          client(connectorAccountsContract).connection({
            params: { connectionId: descriptor.selection.connectionId },
            query: target,
          }),
          [200, 404],
        ),
        accept(
          client(chatConnectorAccessContract).getThread({
            params: { threadId: descriptor.threadId },
            query: target,
          }),
          [200, 404],
        ),
      ]);
      if (account.status === 404 || access.status === 404) {
        return { kind: "unavailable" };
      }
      return {
        kind: "ready",
        account: account.body,
        selected: access.body.currentConnectionId === account.body.id,
      };
    },
  );

  return {
    ...descriptor,
    status$,
    connector$,
    confirm$: createConnectorAccountConfirmSignal(
      descriptor,
      status$,
      connector,
    ),
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

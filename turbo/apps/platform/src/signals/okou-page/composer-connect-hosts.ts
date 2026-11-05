import { command, computed, state, type Command } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ComposerConnectorSignals } from "./connectors.ts";

/**
 * A mounted composer that can be the origin of a connector connection. The
 * connect command finds it by key to finish the addition and close the
 * composer's own connect surface.
 */
export interface ComposerConnectHost {
  readonly agentId: string;
  readonly connector: Pick<
    ComposerConnectorSignals,
    "data$" | "updateConnectorUiState$"
  >;
  /** Resolves to whether this addition newly authorized the connector. */
  readonly completeConnectorAddition$: Command<
    Promise<boolean>,
    [ConnectorSlug, boolean, AbortSignal]
  >;
}

const internalComposerConnectHosts$ = state<
  ReadonlyMap<string, ComposerConnectHost>
>(new Map());

export const composerConnectHosts$ = computed((get) => {
  return get(internalComposerConnectHosts$);
});

/** Registers the composer for the lifetime of its owner's signal. */
export const registerComposerConnectHost$ = command(
  (
    { get, set },
    key: string,
    host: ComposerConnectHost,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(
      internalComposerConnectHosts$,
      new Map(get(internalComposerConnectHosts$)).set(key, host),
    );
    signal.addEventListener(
      "abort",
      () => {
        const current = get(internalComposerConnectHosts$);
        if (current.get(key) !== host) {
          return;
        }
        const next = new Map(current);
        next.delete(key);
        set(internalComposerConnectHosts$, next);
      },
      { once: true },
    );
  },
);

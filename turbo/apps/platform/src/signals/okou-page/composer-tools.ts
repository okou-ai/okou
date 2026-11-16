import { command, computed, state } from "ccstate";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { reloadDisabledPaidTools$ } from "./paid-tools.ts";
import {
  createPaidToolsSignals,
  type DataFamilySettings,
  type PaidToolSettings,
} from "./settings/paid-tools.ts";
import { createPaidToolsCatalogSignals } from "./settings/paid-tools-catalog.ts";

function createComposerToolsSignals(
  createClient: ApiClientFactory,
  assertCurrent: () => void,
) {
  const catalog = createPaidToolsCatalogSignals();
  const tools = createPaidToolsSignals(
    createClient,
    assertCurrent,
    catalog.catalog$,
  );
  // Receipts belong to the member, not the popup or a refreshed catalog row.
  const receipts$ = state<ReadonlyMap<string, Promise<void>>>(new Map());
  const save$ = command(
    async (
      { set },
      tool: PaidToolSettings | DataFamilySettings,
      enabled: boolean,
      previous: Promise<void> | undefined,
      signal: AbortSignal,
    ) => {
      if (previous) {
        // An explicit retry can recover the previous same-tool failure only.
        await Promise.allSettled([previous]);
      }
      signal.throwIfAborted();
      assertCurrent();
      await set(tool.update$, enabled, signal);
    },
  );
  function withReceipt<T extends PaidToolSettings | DataFamilySettings>(
    tool: T,
  ) {
    return {
      ...tool,
      save$: computed((get) => {
        return get(receipts$).get(tool.toolId);
      }),
      update$: command(
        ({ get, set }, enabled: boolean, signal: AbortSignal) => {
          signal.throwIfAborted();
          assertCurrent();
          const receipts = get(receipts$);
          const receipt = set(
            save$,
            tool,
            enabled,
            receipts.get(tool.toolId),
            signal,
          );
          set(receipts$, new Map(receipts).set(tool.toolId, receipt));
          return receipt;
        },
      ),
    };
  }
  return {
    startDiscovery$: catalog.startDiscovery$,
    webSearch: withReceipt(tools.webSearch),
    dataFamilies$: computed(async (get) => {
      return (await get(tools.dataFamilies$)).map(withReceipt);
    }),
  };
}

/** The composer and Settings edit the same authoritative member preferences. */
export const composerTools$ = computed(async (get) => {
  const identity = get(authenticatedSessionKey$);
  const createClient = get(apiClient$);
  if (!identity) {
    return null;
  }
  const clerk = await get(clerk$);
  const assertCurrent = () => {
    if (
      !clerk.user ||
      !clerk.organization ||
      !clerk.session ||
      JSON.stringify([
        clerk.organization.id,
        clerk.user.id,
        clerk.session.id,
      ]) !== identity
    ) {
      throw new DOMException("Composer tools owner changed", "AbortError");
    }
  };
  assertCurrent();
  return {
    key: identity,
    assertCurrent,
    ...createComposerToolsSignals(createClient, assertCurrent),
  };
});

export const startComposerToolsDiscovery$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const identity = get(authenticatedSessionKey$);
    const tools = await get(composerTools$);
    signal.throwIfAborted();
    if (!tools || get(authenticatedSessionKey$) !== identity) {
      throw new DOMException("Composer tools owner changed", "AbortError");
    }
    tools.assertCurrent();
    set(reloadDisabledPaidTools$);
    set(tools.startDiscovery$, signal);
  },
);

export type ComposerToolsSettings = ReturnType<
  typeof createComposerToolsSignals
>;
export type ComposerTool = ComposerToolsSettings["webSearch"];
export type ComposerDataFamily = Awaited<
  ReturnType<ComposerToolsSettings["dataFamilies$"]["read"]>
>[number];

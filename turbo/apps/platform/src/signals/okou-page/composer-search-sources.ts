import { command, computed, state } from "ccstate";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import {
  createPaidToolsSignals,
  type DataFamilySettings,
  type PaidToolSettings,
} from "./settings/paid-tools.ts";
import { startPaidToolsCatalogDiscovery$ } from "./settings/paid-tools-catalog.ts";

function createSearchSourcesSignals(
  createClient: ApiClientFactory,
  assertCurrent: () => void,
) {
  const tools = createPaidToolsSignals(createClient, assertCurrent);
  // Retain only the latest receipt per tool, for this identity owner rather
  // than a disclosure or a reconstructed catalog row. No preferences are copied.
  const receipts$ = state<ReadonlyMap<string, Promise<void>>>(new Map());
  const runUpdate$ = command(
    async (
      { set },
      tool: PaidToolSettings | DataFamilySettings,
      enabled: boolean,
      previous: Promise<void> | undefined,
      signal: AbortSignal,
    ) => {
      if (previous) {
        // Only the prior same-tool receipt is recoverable: a new explicit
        // save may retry it. The current write's failures still propagate.
        await Promise.allSettled([previous]);
      }
      signal.throwIfAborted();
      assertCurrent();
      await set(tool.update$, enabled, signal);
    },
  );
  function sourceTool<T extends PaidToolSettings | DataFamilySettings>(
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
            runUpdate$,
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
    webSearch: sourceTool(tools.webSearch),
    dataFamilies$: computed(async (get) => {
      return (await get(tools.dataFamilies$)).map(sourceTool);
    }),
  };
}

/** Account preferences are shared with Settings, never a composer-local copy. */
export const composerSearchSources$ = computed(async (get) => {
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
      throw new DOMException("Search sources owner changed", "AbortError");
    }
  };
  assertCurrent();
  return {
    key: identity,
    assertCurrent,
    ...createSearchSourcesSignals(createClient, assertCurrent),
  };
});

/** Explicit disclosure discovers sources; it never changes a preference. */
export const startComposerSearchSources$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const identity = get(authenticatedSessionKey$);
    const sources = await get(composerSearchSources$);
    signal.throwIfAborted();
    if (!sources || get(authenticatedSessionKey$) !== identity) {
      throw new DOMException("Search sources owner changed", "AbortError");
    }
    sources.assertCurrent();
    set(startPaidToolsCatalogDiscovery$, signal);
  },
);

export type ComposerSearchSourcesSettings = ReturnType<
  typeof createSearchSourcesSignals
>;
export type ComposerSearchSource = ComposerSearchSourcesSettings["webSearch"];
export type ComposerSearchDataFamily = Awaited<
  ReturnType<ComposerSearchSourcesSettings["dataFamilies$"]["read"]>
>[number];

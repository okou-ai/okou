import { AVAILABLE_PAID_TOOL_IDS } from "@okouai/api-contracts/validators/paid-tools";
import { paidToolsContract } from "@okouai/api-contracts/client/paid-tools";
import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import { userModelPreferenceContract } from "@okouai/api-contracts/client/user-model-preference";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { command, computed, state, type Computed } from "ccstate";
import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../../auth.ts";
import { effectiveImageModel$ } from "../../external/user-model-preference.ts";
import { disabledPaidTools$, reloadDisabledPaidTools$ } from "../paid-tools.ts";
import { dataRouterCatalog$ } from "./paid-tools-catalog.ts";
import {
  settingsActiveSection$,
  settingsDialogOpen$,
  settingsVisit$,
} from "./settings-dialog.ts";

const OKOU_PAID_TOOL_IDS: ReadonlySet<string> = new Set(
  AVAILABLE_PAID_TOOL_IDS,
);

function createPaidToolsSignals(
  createClient: ApiClientFactory,
  assertCurrent: () => void,
) {
  const client = createClient(paidToolsContract, {
    getTokenGuard: () => {
      assertCurrent();
      return assertCurrent;
    },
  });
  const disabledTools$ = disabledPaidTools$;
  const imageModel = createImageModelSignals(createClient, assertCurrent);
  function createTool<T extends PaidToolId>(toolId: T) {
    const enabled$ = computed(async (get) => {
      const disabledTools = await get(disabledTools$);
      return !disabledTools.includes(toolId);
    });
    const update$ = command(
      async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
        signal.throwIfAborted();
        assertCurrent();
        const response = await accept(
          client.update({
            params: { toolId },
            body: { disabled: !enabled },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        signal.throwIfAborted();
        assertCurrent();
        if (toolId === "image-generation" && response.body.disabled) {
          set(imageModel.discardDraft$);
        }
        set(reloadDisabledPaidTools$);
        // Keep this row saving until its confirmed state is visible again.
        await get(enabled$);
        signal.throwIfAborted();
        assertCurrent();
      },
    );
    return { toolId, enabled$, update$ };
  }
  const webSearch = createTool("web-search");
  const imageGeneration = createTool("image-generation");
  // Okou owns web search and image generation; Router's family with an Okou
  // tool ID is controlled by that Okou row.
  const dataFamilies$ = computed(async (get) => {
    assertCurrent();
    const families = await get(dataRouterCatalog$);
    assertCurrent();
    return families
      .filter((family) => {
        return !OKOU_PAID_TOOL_IDS.has(family.id);
      })
      .map((family) => {
        return { ...createTool(family.id), family };
      });
  });
  return {
    disabledTools$,
    webSearch,
    imageGeneration,
    dataFamilies$,
    imageModel,
  };
}

/**
 * The member's image model for built-in image generation. It lives in the
 * user model preference rather than the sparse disabled-tools table, so it is
 * read and written through that resource and its realtime refreshes.
 */
function createImageModelSignals(
  createClient: ApiClientFactory,
  assertCurrent: () => void,
) {
  const client = createClient(userModelPreferenceContract, {
    apiBase: "api",
    getTokenGuard: () => {
      assertCurrent();
      return assertCurrent;
    },
  });
  // This unsaved choice belongs to one member and Settings visit. Keep it
  // visible after failure; a confirmed save reconciles it with the baseline,
  // and leaving this Settings owner discards it.
  const draft$ = state<ImageModel | null>(null);
  const discardDraft$ = command(({ set }) => {
    assertCurrent();
    set(draft$, null);
  });
  const update$ = command(
    async ({ set }, model: ImageModel, signal: AbortSignal) => {
      signal.throwIfAborted();
      assertCurrent();
      set(draft$, model);
      const preference = await accept(
        client.get({ fetchOptions: { signal } }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      assertCurrent();
      await accept(
        client.update({
          body: {
            selectedModel: preference.body.selectedModel,
            serviceTier: preference.body.serviceTier,
            selectedImageModel: model,
          },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      assertCurrent();
      set(draft$, null);
    },
  );
  return {
    selected$: effectiveImageModel$,
    draft$: computed((get) => {
      return get(draft$);
    }),
    discardDraft$,
    update$,
  };
}

const paidToolsActive$ = computed((get) => {
  return get(settingsActiveSection$) === "tools";
});

/** One current identity and settings visit; same-identity refreshes retain it. */
export const paidToolsSettings$ = computed(async (get) => {
  const visit = get(settingsVisit$);
  const open = get(settingsDialogOpen$);
  const active = get(paidToolsActive$);
  const identity = get(authenticatedSessionKey$);
  const createClient = get(apiClient$);
  if (!open || !active || !identity) {
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
      throw new DOMException("Paid tools settings owner changed", "AbortError");
    }
  };
  assertCurrent();
  return {
    key: `${identity}:${visit}`,
    ...createPaidToolsSignals(createClient, assertCurrent),
  };
});

export type PaidToolsSettings = ReturnType<typeof createPaidToolsSignals> & {
  readonly key: string;
};
export type PaidToolSettings =
  PaidToolsSettings["webSearch"] | PaidToolsSettings["imageGeneration"];
export type DataFamilySettings =
  PaidToolsSettings["dataFamilies$"] extends Computed<Promise<infer Families>>
    ? Families extends readonly (infer Family)[]
      ? Family
      : never
    : never;
export type ImageModelSettings = PaidToolsSettings["imageModel"];

import { command, computed, state } from "ccstate";
import {
  AVAILABLE_PAID_TOOL_IDS,
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { accept } from "../../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../../auth.ts";
import {
  effectiveImageModel$,
  reloadUserModelPreference$,
  userModelPreference$,
} from "../../external/user-model-preference.ts";
import { reloadDisabledPaidTools$ } from "../paid-tools.ts";
import {
  settingsActiveSection$,
  settingsDialogOpen$,
  settingsVisit$,
} from "./settings-dialog.ts";

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
  const revision$ = state(0);
  const confirmedChanges$ = state<Partial<Record<PaidToolId, boolean>>>({});
  const disabledTools$ = computed(async (get) => {
    get(revision$);
    assertCurrent();
    const response = await accept(client.get(), [200]);
    assertCurrent();
    return response.body.disabledTools;
  });
  const retry$ = command(({ set }) => {
    assertCurrent();
    set(revision$, (revision) => {
      return revision + 1;
    });
  });
  const imageModel = createImageModelSignals(createClient, assertCurrent);
  const tools = AVAILABLE_PAID_TOOL_IDS.map((toolId) => {
    const enabled$ = computed(async (get) => {
      const changes = get(confirmedChanges$);
      const disabledTools = await get(disabledTools$);
      return !(changes[toolId] ?? disabledTools.includes(toolId));
    });
    const update$ = command(
      async ({ set }, enabled: boolean, signal: AbortSignal) => {
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
        // Merge only the confirmed tool so simultaneous saves cannot replace
        // another row's result with an older full-list response.
        set(confirmedChanges$, (changes) => {
          return {
            ...changes,
            [response.body.toolId]: response.body.disabled,
          };
        });
        if (toolId === "image-generation" && response.body.disabled) {
          set(imageModel.discardDraft$);
        }
        set(reloadDisabledPaidTools$);
      },
    );
    return { toolId, enabled$, update$ };
  });
  return {
    disabledTools$,
    retry$,
    tools,
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
    async ({ get, set }, model: ImageModel, signal: AbortSignal) => {
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
      // The realtime push refreshes other sessions; this one reads its own
      // write back so the save settles on the stored value.
      set(reloadUserModelPreference$);
      await get(userModelPreference$);
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
export type PaidToolSettings = PaidToolsSettings["tools"][number];
export type ImageModelSettings = PaidToolsSettings["imageModel"];

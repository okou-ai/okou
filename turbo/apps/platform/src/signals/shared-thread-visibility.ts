import { command, computed, state } from "ccstate";
import { sharedThreadVisibilityContract } from "@okouai/api-contracts/client/shared-thread-visibility";
import type { SharedThreadAudience } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { currentUserInfo$ } from "./auth.ts";
import { throttleCommand } from "./command-scheduling.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { createShareLinkCopy } from "./share-link-copy.ts";

export function createSharedThreadVisibilitySignals(id: string) {
  const reload$ = state(0);
  const saveError$ = state<string | null>(null);
  const status$ = computed(async (get) => {
    get(reload$);
    if (!get(featureSwitch$)[FeatureSwitchKey.SharedThreadVisibility]) {
      return null;
    }
    const user = await get(currentUserInfo$);
    if (!user) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(sharedThreadVisibilityContract).get({
        params: { id },
        fetchOptions: { cache: "no-store" },
      }),
      [200, 401, 403, 404],
    );
    return result.status === 200 ? result.body : null;
  });
  const persist$ = command(
    async (
      { get, set },
      audience: SharedThreadAudience,
      signal: AbortSignal,
    ) => {
      set(saveError$, null);
      const current = await get(status$);
      signal.throwIfAborted();
      if (!current || current.audience === audience) {
        return;
      }
      const result = await accept(
        get(apiClient$)(sharedThreadVisibilityContract).update({
          params: { id },
          body: { audience, expectedRevision: current.revision },
          fetchOptions: { signal },
        }),
        [200, 400, 409],
        signal,
      );
      if (result.status === 400) {
        set(saveError$, result.body.error.message);
        return;
      }
      set(reload$, (value) => {
        return value + 1;
      });
      await get(status$);
      signal.throwIfAborted();
      if (result.status === 409) {
        toast.error(
          i18n.t(($) => {
            return $.artifacts.sharing.updateFailed;
          }),
        );
        return;
      }
      toast.success(
        i18n.t(($) => {
          return $.artifacts.sharing.permissionsUpdated;
        }),
      );
    },
  );
  const save$ = throttleCommand(persist$, 0);
  const url = new URL(
    `/share/threads/${encodeURIComponent(id)}`,
    window.location.origin,
  ).href;
  const copy = createShareLinkCopy();
  return {
    status$,
    saveError$: computed((get) => {
      return get(saveError$);
    }),
    change$: command(
      ({ set }, audience: SharedThreadAudience, signal: AbortSignal) => {
        set(copy.clear$);
        return set(save$, audience, signal);
      },
    ),
    url,
    copied$: computed((get) => {
      return get(copy.copiedUrl$) === url;
    }),
    copy$: command(({ set }, signal: AbortSignal) => {
      return set(copy.copy$, url, signal);
    }),
  };
}

export type SharedThreadVisibilitySignals = ReturnType<
  typeof createSharedThreadVisibilitySignals
>;

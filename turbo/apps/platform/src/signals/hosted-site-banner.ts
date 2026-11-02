import { command, computed, state, type Computed } from "ccstate";
import type { infer as zInfer } from "zod";
import { hostContract } from "@okouai/api-contracts/client/host";
import type { hostedSiteVisibilityStatusSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";

export function createHostedSiteBannerSignals(
  site$: Computed<
    Promise<zInfer<typeof hostedSiteVisibilityStatusSchema> | null>
  >,
) {
  const reload$ = state(0);
  const banner$ = computed(async (get) => {
    get(reload$);
    const site = await get(site$);
    if (!site) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(hostContract).siteBanner({
        params: { siteId: site.siteId },
        fetchOptions: { cache: "no-store" },
      }),
      [200, 404],
    );
    return result.status === 200 ? result.body : null;
  });
  const refreshBanner$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
    await get(banner$);
    signal.throwIfAborted();
  });
  const changeBanner$ = command(
    async ({ get, set }, showBanner: boolean, signal: AbortSignal) => {
      const current = await get(banner$);
      signal.throwIfAborted();
      if (!current || current.showBanner === showBanner) {
        return;
      }
      await accept(
        get(apiClient$)(hostContract).updateSiteBanner({
          params: { siteId: current.siteId },
          body: { showBanner, expectedRevision: current.revision },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      await set(refreshBanner$, signal);
      toast.success(
        i18n.t(($) => {
          return $.artifacts.siteBanner.updated;
        }),
      );
    },
  );
  return { banner$, changeBanner$ };
}

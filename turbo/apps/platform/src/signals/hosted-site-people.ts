import { command, computed, state, type Computed, type State } from "ccstate";
import { hostedSiteSharingContract } from "@okouai/api-contracts/client/hosted-site-sharing";
import { hostedSiteShareEmailSchema } from "@okouai/api-contracts/validators/hosted-site-sharing";
import type { hostedSiteVisibilityStatusSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import type { infer as zInfer } from "zod";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$ } from "./api-client.ts";
import { debounceCommand, resetSignal, throttleCommand } from "./utils.ts";

type SiteVisibility = zInfer<typeof hostedSiteVisibilityStatusSchema>;

function createPeopleSearch(
  visibility$: Computed<Promise<SiteVisibility | null>>,
) {
  const input$ = state("");
  const resetSearch$ = resetSignal();
  const validEmail$ = computed((get) => {
    return hostedSiteShareEmailSchema.safeParse(get(input$)).success;
  });
  const search$ = debounceCommand(
    command(async ({ get }, query: string, signal: AbortSignal) => {
      const site = await get(visibility$);
      signal.throwIfAborted();
      if (!site) {
        return [];
      }
      const result = await accept(
        get(apiClient$)(hostedSiteSharingContract).search({
          params: { siteId: site.siteId },
          query: { query },
          fetchOptions: { signal, cache: "no-store" },
        }),
        [200],
        signal,
      );
      return result.body.accounts;
    }),
    300,
  );
  const change$ = command(
    async ({ set }, value: string, parentSignal: AbortSignal) => {
      const signal = set(resetSearch$, parentSignal);
      set(input$, value);
      return value.trim().length < 2
        ? []
        : await set(search$, value.trim(), signal);
    },
  );
  const clear$ = command(({ set }) => {
    set(resetSearch$);
    set(input$, "");
  });
  return { input$, validEmail$, change$, clear$ };
}

export function createHostedSitePeopleSignals(
  visibility$: Computed<Promise<SiteVisibility | null>>,
  open$: State<boolean>,
) {
  const search = createPeopleSearch(visibility$);
  const reload$ = state(0);
  const shares$ = computed(async (get) => {
    get(reload$);
    if (!get(open$)) {
      return null;
    }
    const site = await get(visibility$);
    if (!site) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(hostedSiteSharingContract).list({
        params: { siteId: site.siteId },
        fetchOptions: { cache: "no-store" },
      }),
      [200],
    );
    return response.body.shares;
  });
  const share$ = throttleCommand(
    command(async ({ get, set }, rawEmail: string, signal: AbortSignal) => {
      const email = hostedSiteShareEmailSchema.parse(rawEmail);
      const site = await get(visibility$);
      signal.throwIfAborted();
      if (!site) {
        return;
      }
      await accept(
        get(apiClient$)(hostedSiteSharingContract).share({
          params: { siteId: site.siteId },
          body: { email },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      set(search.clear$);
      set(reload$, (value) => {
        return value + 1;
      });
      toast.success(
        i18n.t(($) => {
          return $.artifacts.people.invitationProcessed;
        }),
      );
    }),
    0,
  );
  const remove$ = throttleCommand(
    command(async ({ get, set }, shareId: string, signal: AbortSignal) => {
      const site = await get(visibility$);
      signal.throwIfAborted();
      if (!site) {
        return;
      }
      await accept(
        get(apiClient$)(hostedSiteSharingContract).remove({
          params: { siteId: site.siteId, shareId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      set(reload$, (value) => {
        return value + 1;
      });
      toast.success(
        i18n.t(($) => {
          return $.artifacts.people.removed;
        }),
      );
    }),
    0,
  );
  return { ...search, shares$, share$, remove$ };
}

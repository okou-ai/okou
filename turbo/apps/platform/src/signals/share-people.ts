import { command, computed, state, type Computed, type State } from "ccstate";
import { artifactSharingContract } from "@okouai/api-contracts/client/artifact-sharing";
import { hostedSiteShareEmailSchema } from "@okouai/api-contracts/validators/hosted-site-sharing";
import type { ArtifactSharingTarget } from "@okouai/api-contracts/contracts/artifact-sharing";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$ } from "./api-client.ts";
import { debounceCommand, resetSignal, throttleCommand } from "./utils.ts";

type SharingResource = ArtifactSharingTarget;

function createPeopleSearch(
  resource$: Computed<Promise<SharingResource | null>>,
) {
  const input$ = state("");
  const searchOpen$ = state(false);
  const setSearchOpen$ = command(({ set }, open: boolean) => {
    set(searchOpen$, open);
  });
  const resetSearch$ = resetSignal();
  const validEmail$ = computed((get) => {
    return hostedSiteShareEmailSchema.safeParse(get(input$)).success;
  });
  const search$ = debounceCommand(
    command(async ({ get }, query: string, signal: AbortSignal) => {
      const site = await get(resource$);
      signal.throwIfAborted();
      if (!site) {
        return [];
      }
      const result = await accept(
        get(apiClient$)(artifactSharingContract).search({
          params: site,
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
    set(searchOpen$, false);
  });
  return { input$, validEmail$, change$, clear$, searchOpen$, setSearchOpen$ };
}

export function createSharePeopleSignals(
  resource$: Computed<Promise<SharingResource | null>>,
  open$: State<boolean>,
) {
  const search = createPeopleSearch(resource$);
  const reload$ = state(0);
  const shares$ = computed(async (get) => {
    get(reload$);
    if (!get(open$)) {
      return null;
    }
    const site = await get(resource$);
    if (!site) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(artifactSharingContract).list({
        params: site,
        fetchOptions: { cache: "no-store" },
      }),
      [200],
    );
    return response.body.shares;
  });
  const share$ = throttleCommand(
    command(async ({ get, set }, rawEmail: string, signal: AbortSignal) => {
      const email = hostedSiteShareEmailSchema.parse(rawEmail);
      const site = await get(resource$);
      signal.throwIfAborted();
      if (!site) {
        return;
      }
      await accept(
        get(apiClient$)(artifactSharingContract).share({
          params: site,
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
      const site = await get(resource$);
      signal.throwIfAborted();
      if (!site) {
        return;
      }
      await accept(
        get(apiClient$)(artifactSharingContract).remove({
          params: { ...site, shareId },
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

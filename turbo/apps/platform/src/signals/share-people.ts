import { command, computed, state, type Computed } from "ccstate";
import type {
  ArtifactShareAccount,
  ArtifactUserShareEntry,
} from "@okouai/api-contracts/contracts/artifact-access";
import { artifactAccessContract } from "@okouai/api-contracts/client/artifact-access";
import { artifactShareEmailSchema } from "@okouai/api-contracts/validators/artifact-access";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$, type ApiClientFactory } from "./api-client.ts";
import { debounceCommand, resetSignal, throttleCommand } from "./utils.ts";

export interface SharePeopleResource {
  readonly artifactId: string;
}

export type ShareRecipientInput =
  { readonly userId: string } | { readonly email: string };

function createPeopleSearch(
  resource$: Computed<Promise<SharePeopleResource | null>>,
) {
  const input$ = state("");
  const searchOpen$ = state(false);
  const suggestedAccounts$ = state<readonly ArtifactShareAccount[]>([]);
  const setSearchOpen$ = command(({ set }, open: boolean) => {
    set(searchOpen$, open);
  });
  const resetSearch$ = resetSignal();
  const validEmail$ = computed((get) => {
    return artifactShareEmailSchema.safeParse(get(input$)).success;
  });
  const search$ = debounceCommand(
    command(async ({ get, set }, query: string, signal: AbortSignal) => {
      const resource = await get(resource$);
      signal.throwIfAborted();
      if (!resource) {
        set(suggestedAccounts$, []);
        return [];
      }
      const result = await accept(
        get(apiClient$)(artifactAccessContract).searchShareAccounts({
          params: { artifactId: resource.artifactId },
          query: { query },
          fetchOptions: { signal, cache: "no-store" },
        }),
        [200],
        signal,
      );
      set(suggestedAccounts$, result.body.accounts);
      return result.body.accounts;
    }),
    300,
  );
  const change$ = command(
    async ({ set }, value: string, parentSignal: AbortSignal) => {
      const signal = set(resetSearch$, parentSignal);
      set(input$, value);
      if (value.trim().length < 2) {
        set(suggestedAccounts$, []);
        return [];
      }
      return await set(search$, value.trim(), signal);
    },
  );
  const clear$ = command(({ set }) => {
    set(resetSearch$);
    set(input$, "");
    set(suggestedAccounts$, []);
    set(searchOpen$, false);
  });
  return {
    input$,
    validEmail$,
    suggestedAccounts$,
    change$,
    clear$,
    searchOpen$,
    setSearchOpen$,
  };
}

function createPeopleList(
  resource$: Computed<Promise<SharePeopleResource | null>>,
) {
  const reload$ = state(0);
  const request$ = state<
    | ((
        client: ApiClientFactory,
        resource: SharePeopleResource,
      ) => Promise<ArtifactUserShareEntry[]>)
    | null
  >(null);
  const shares$ = computed(async (get) => {
    get(reload$);
    const request = get(request$);
    if (!request) {
      return null;
    }
    const resource = await get(resource$);
    if (!resource) {
      return null;
    }
    return request(get(apiClient$), resource);
  });
  const open$ = command(({ set }, signal: AbortSignal) => {
    set(request$, () => {
      return async (
        client: ApiClientFactory,
        resource: SharePeopleResource,
      ) => {
        signal.throwIfAborted();
        const response = await accept(
          client(artifactAccessContract).listShares({
            params: { artifactId: resource.artifactId },
            fetchOptions: { cache: "no-store", signal },
          }),
          [200],
          signal,
        );
        return response.body.shares;
      };
    });
  });
  return { shares$, reload$, open$ };
}

export function createSharePeopleSignals(
  resource$: Computed<Promise<SharePeopleResource | null>>,
) {
  const search = createPeopleSearch(resource$);
  const { shares$, reload$, open$ } = createPeopleList(resource$);
  const share$ = throttleCommand(
    command(
      async (
        { get, set },
        recipient: string | ShareRecipientInput,
        signal: AbortSignal,
      ) => {
        const body =
          typeof recipient === "string"
            ? (() => {
                const email = artifactShareEmailSchema.parse(recipient);
                const matched = get(search.suggestedAccounts$).find(
                  (account) => {
                    return account.email === email;
                  },
                );
                return matched ? { userId: matched.userId } : { email };
              })()
            : "userId" in recipient
              ? { userId: recipient.userId }
              : { email: artifactShareEmailSchema.parse(recipient.email) };
        const resource = await get(resource$);
        signal.throwIfAborted();
        if (!resource) {
          return;
        }
        await accept(
          get(apiClient$)(artifactAccessContract).addShare({
            params: { artifactId: resource.artifactId },
            body,
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        signal.throwIfAborted();
        set(search.clear$);
        set(reload$, (value) => {
          return value + 1;
        });
        toast.success(
          i18n.t(($) => {
            return $.artifacts.people.invitationProcessed;
          }),
        );
      },
    ),
    0,
  );
  const remove$ = throttleCommand(
    command(async ({ get, set }, userId: string, signal: AbortSignal) => {
      const resource = await get(resource$);
      signal.throwIfAborted();
      if (!resource) {
        return;
      }
      await accept(
        get(apiClient$)(artifactAccessContract).removeShare({
          params: { artifactId: resource.artifactId, userId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
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
  return { ...search, shares$, share$, remove$, open$ };
}

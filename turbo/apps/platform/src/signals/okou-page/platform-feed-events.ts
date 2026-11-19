import { command, state, type Command } from "ccstate";
import type { PlatformEvent } from "@okouai/api-contracts/contracts/feed";
import { feedContract } from "@okouai/api-contracts/client/feed";
import { workflowAutomationsContract } from "@okouai/api-contracts/client/workflows";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { ROUTES } from "../route-paths.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { createForYouReadRef } from "./for-you-sources.ts";

export function createPlatformEventEntry(
  item: PlatformEvent,
  reloadFeed$: Command<void, []>,
) {
  const dismissed$ = state(false);
  const enabled$ = state(false);
  const dismiss$ = command(async ({ get, set }, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(feedContract).dismiss({
        params: { id: item.id },
        fetchOptions: { signal },
      }),
      [204, 404],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    set(dismissed$, true);
    set(reloadFeed$);
  });
  const enable$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(enabled$)) {
      await accept(
        get(apiClient$)(workflowAutomationsContract).enable({
          params: { id: item.content.automationId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
        { showErrorToast: false },
      );
      // A receipt retry must not reset the automation's schedule again.
      set(enabled$, true);
    }
    // Persist dismissal before navigation cancels this page's requests.
    await set(dismiss$, signal);
    set(detachedNavigateTo$, ROUTES.workflowDetailAutomations, {
      pathParams: { workflowId: item.content.workflowId },
      searchParams: new URLSearchParams({
        automationId: item.content.automationId,
        workspaceId: item.content.workspaceId,
      }),
    });
  });
  return {
    item,
    dismissed$,
    dismiss$,
    enable$,
    readOnRef$: createForYouReadRef(item.id),
  };
}

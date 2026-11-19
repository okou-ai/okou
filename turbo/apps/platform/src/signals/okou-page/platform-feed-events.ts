import { command, state, type State } from "ccstate";
import type { PlatformEvent } from "@okouai/api-contracts/contracts/feed";
import { feedContract } from "@okouai/api-contracts/client/feed";
import { workflowAutomationsContract } from "@okouai/api-contracts/client/workflows";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { reloadWorkflowData$ } from "../workflows-page/workflow-reload.ts";
import { createForYouReadRef } from "./for-you-sources.ts";

export function createPlatformEventEntry(
  item: PlatformEvent,
  settledOrder$: State<readonly string[]>,
) {
  const dismissed$ = state(false);
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
    set(settledOrder$, (ids) => {
      return [
        ...ids.filter((id) => {
          return id !== item.id;
        }),
        item.id,
      ];
    });
  });
  const enable$ = command(async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    const request = {
      params: { id: item.content.automationId },
      fetchOptions: { signal },
    };
    const options = { showErrorToast: false };
    const current = await accept(client.get(request), [200], signal, options);
    // Recovery, another tab, or an earlier attempt may already have enabled it.
    if (!current.body.enabled) {
      await accept(client.enable(request), [200], signal, options);
    }
    signal.throwIfAborted();
    set(reloadWorkflowData$);
    await set(dismiss$, signal);
  });
  return {
    item,
    dismissed$,
    dismiss$,
    enable$,
    readOnRef$: createForYouReadRef(item.id),
  };
}

import { command, state, type State } from "ccstate";
import type { PlatformEvent } from "@okouai/api-contracts/contracts/feed";
import { feedContract } from "@okouai/api-contracts/client/feed";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
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
  return {
    item,
    dismissed$,
    dismiss$,
    readOnRef$: createForYouReadRef(item.id),
  };
}

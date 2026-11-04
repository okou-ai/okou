import { chatThreadByIdContract } from "@okouai/api-contracts/client/chat-threads";
import { command, computed, state, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  createBrowserSessionSignals,
  type BrowserSessionSignals,
} from "../chat-page/browser-session-block.ts";

export interface BrowserSessionPageSignals {
  readonly browser: BrowserSessionSignals;
  readonly threadAccessible$: Computed<Promise<boolean>>;
}

export function createBrowserSessionPageSignals(
  threadId: string,
): BrowserSessionPageSignals {
  const browser = createBrowserSessionSignals(threadId);
  const threadAccessible$ = computed(async (get): Promise<boolean> => {
    const session = await get(browser.session$);
    if (session) {
      return true;
    }
    const response = await accept(
      get(apiClient$)(chatThreadByIdContract).get({
        params: { id: threadId },
      }),
      [200, 404],
    );
    return response.status === 200;
  });
  return { browser, threadAccessible$ };
}

const browserSessionPageSignalsState$ = state<BrowserSessionPageSignals | null>(
  null,
);

export const browserSessionPageSignals$ = computed((get) => {
  return get(browserSessionPageSignalsState$);
});

export const setBrowserSessionPageSignals$ = command(
  ({ set }, value: BrowserSessionPageSignals | null) => {
    set(browserSessionPageSignalsState$, value);
  },
);

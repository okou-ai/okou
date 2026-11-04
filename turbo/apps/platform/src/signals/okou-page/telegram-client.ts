import { computed } from "ccstate";
import { integrationsTelegramContract } from "@okouai/api-contracts/client/integrations-telegram";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";

/** Never send an old operation's proof with a newly selected account's token. */
export const telegramClient$ = computed(async (get) => {
  const owner = get(authenticatedSessionKey$);
  const createClient = get(apiClient$);
  const clerk = await get(clerk$);
  const isCurrent = () => {
    return (
      owner !== null &&
      owner ===
        JSON.stringify([
          clerk.organization?.id,
          clerk.user?.id,
          clerk.session?.id,
        ])
    );
  };
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new DOMException("Telegram connection owner changed", "AbortError");
    }
  };
  assertCurrent();
  return {
    clerk,
    isCurrent,
    assertCurrent,
    client: createClient(integrationsTelegramContract, {
      getTokenGuard: () => {
        assertCurrent();
        return assertCurrent;
      },
    }),
  };
});

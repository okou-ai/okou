import { command, computed } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { hash$, replaceSearchParams$, searchParams$ } from "../route.ts";
import { parseTelegramConnectParams } from "./telegram-connect-params.ts";
import {
  authorizeTelegramBot$,
  linkTelegramAccount$,
} from "./telegram-authorization.ts";
import { telegramClient$ } from "./telegram-client.ts";
import { telegramBots$, reloadTelegramBots$ } from "./telegram.ts";
import { onboardingStatus$, reloadOnboardingStatus$ } from "./onboarding.ts";
import { resetSignal, withCleanup } from "../utils.ts";

export const telegramConnectLinkStatus$ = computed(async (get) => {
  const parsed = parseTelegramConnectParams(get(searchParams$));
  if (!parsed.ok) {
    return null;
  }
  // The existing bot invalidation owns realtime/focus and post-binding reads.
  const owner = await get(telegramClient$);
  const bots = await get(telegramBots$);
  owner.assertCurrent();
  const result = await accept(
    owner.client.getLinkStatus({
      headers: {},
      query: {
        botId: parsed.params.telegramBotId,
        ...(parsed.params.connectSignature
          ? {}
          : { origin: location.origin, source: "connect_page" as const }),
      },
    }),
    [200],
  );
  owner.assertCurrent();
  return {
    status: result.body,
    bot: bots.find((bot) => {
      return bot.id === parsed.params.telegramBotId;
    }),
  };
});

export const refreshTelegramConnection$ = command(({ set }) => {
  set(reloadTelegramBots$);
  set(reloadOnboardingStatus$);
});

const resetConnection$ = resetSignal();
export const connectTelegramAccount$ = command(
  async ({ get, set }, parentSignal: AbortSignal) => {
    const signal = set(resetConnection$, parentSignal);
    const parsed = parseTelegramConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }
    const { params } = parsed;
    const signature = params.connectSignature;
    if (!signature) {
      return await set(
        authorizeTelegramBot$,
        params.telegramBotId,
        "connect_page",
        signal,
      );
    }
    const owner = await get(telegramClient$);
    signal.throwIfAborted();
    owner.assertCurrent();
    const unsubscribe = owner.clerk.addListener(() => {
      if (!owner.isCurrent()) {
        set(resetConnection$);
      }
    });
    const confirm = async () => {
      // Signed confirmation must retain its proof while setup opens separately.
      const setup = await get(onboardingStatus$);
      signal.throwIfAborted();
      if (!setup.hasOrg || !setup.hasDefaultAgent) {
        return null;
      }
      const current = await get(telegramConnectLinkStatus$);
      signal.throwIfAborted();
      owner.assertCurrent();
      if (current?.status.linked) {
        return null;
      }
      const result = await set(
        linkTelegramAccount$,
        {
          telegramBotId: params.telegramBotId,
          connectSignature: signature,
        },
        signal,
      );
      signal.throwIfAborted();
      const remaining = new URLSearchParams(get(searchParams$));
      for (const key of [
        "tgUser",
        "tgUserName",
        "tgDisplayName",
        "ts",
        "sig",
      ]) {
        remaining.delete(key);
      }
      set(replaceSearchParams$, remaining, {}, get(hash$));
      set(refreshTelegramConnection$);
      return result;
    };
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    return await withCleanup(confirm(), unsubscribe);
  },
);

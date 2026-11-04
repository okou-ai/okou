import { command, computed } from "ccstate";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/client/feishu-browser-connect";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";

interface FeishuConnectParams {
  readonly installationId: string;
  readonly openId: string;
  readonly chatId: string;
  readonly ts: number;
  readonly sig: string;
}

export const hasFeishuConnectParams$ = computed((get): boolean => {
  const params = get(searchParams$);
  return params.get("connect") === "account";
});

const feishuConnectParams$ = computed((get): FeishuConnectParams | null => {
  const params = get(searchParams$);
  const installationId = params.get("installationId");
  const openId = params.get("openId");
  const chatId = params.get("chatId");
  const timestamp = Number(params.get("ts"));
  const sig = params.get("sig");

  if (
    !installationId ||
    !openId ||
    !chatId ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    !sig
  ) {
    return null;
  }

  return {
    installationId,
    openId,
    chatId,
    ts: timestamp,
    sig,
  };
});

export const connectFeishuAccount$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<"invalid_link" | "redirecting"> => {
    signal.throwIfAborted();
    const params = get(feishuConnectParams$);
    if (!params) {
      return "invalid_link";
    }

    const client = get(apiClient$)(feishuBrowserConnectContract);
    const result = await accept(
      client.connectFromApp({
        body: params,
        fetchOptions: { signal },
      }),
      [200, 400],
      signal,
    );
    signal.throwIfAborted();

    if (result.status === 400) {
      if (result.body.error.code === "FEISHU_CONNECT_LINK_INVALID") {
        return "invalid_link";
      }
      return await accept(Promise.resolve(result), [200], signal);
    }

    window.location.assign(result.body.openUrl);
    return "redirecting";
  },
);

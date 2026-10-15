import { z } from "zod";

export const discordOauthResultSchema = z.object({
  type: z.literal("discord-oauth-result"),
  state: z.string(),
  status: z.enum(["connected", "error"]),
});

export type DiscordOauthResult = z.infer<typeof discordOauthResultSchema>;

const discordOauthReadySchema = z.object({
  type: z.literal("discord-oauth-ready"),
  state: z.string(),
});

/** Retain a terminal result until the consent page has installed its listener. */
export function createDiscordOauthResultNotifier(
  popup: Window,
  state: string,
  signal: AbortSignal,
  onDelivered: () => void,
) {
  const origin = window.location.origin;
  let ready = false;
  let result: DiscordOauthResult | null = null;
  const dispose = () => {
    window.removeEventListener("message", onReady);
  };
  const deliver = () => {
    if (popup.closed) {
      dispose();
      onDelivered();
      return;
    }
    if (ready && result) {
      popup.postMessage(result, origin);
      dispose();
      onDelivered();
    }
  };
  const onReady = (event: MessageEvent<unknown>) => {
    if (event.origin !== origin || event.source !== popup) {
      return;
    }
    const message = discordOauthReadySchema.safeParse(event.data);
    if (!message.success || message.data.state !== state) {
      return;
    }
    ready = true;
    deliver();
  };
  signal.throwIfAborted();
  window.addEventListener("message", onReady, { signal });
  return {
    notify(status: DiscordOauthResult["status"]) {
      signal.throwIfAborted();
      result = { type: "discord-oauth-result", state, status };
      deliver();
    },
    dispose,
  };
}

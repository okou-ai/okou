import {
  literal,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

export const discordOauthResultSchema = object({
  type: literal("discord-oauth-result"),
  state: string(),
  status: zEnum(["connected", "error"]),
});

export type DiscordOauthResult = zInfer<typeof discordOauthResultSchema>;

const discordOauthReadySchema = object({
  type: literal("discord-oauth-ready"),
  state: string(),
});

/** Retain a terminal result until the consent page has installed its listener. */
export function createDiscordOauthResultNotifier(
  popup: Window,
  state: string,
  onDelivered: () => void,
  signal: AbortSignal,
) {
  const origin = window.location.origin;
  let ready = false;
  let result: DiscordOauthResult | null = null;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    window.removeEventListener("message", onReady);
  };
  const deliver = () => {
    if (disposed) {
      return;
    }
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

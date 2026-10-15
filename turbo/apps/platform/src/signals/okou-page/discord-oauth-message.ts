import { z } from "zod";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { now } from "../../lib/time.ts";
import { setLoop } from "../utils.ts";

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
      if (disposed) {
        return;
      }
      // App 0.1025 consent never sends ready. Retain late-ready delivery for
      // five seconds after actual completion, then use its navigation protocol.
      // #40196: remove when the deployed reader and web floor exclude 0.1025.
      // Silence is not a version proof; the clean page must read real status.
      const deadline = now() + 5000;
      setLoop(
        () => {
          if (disposed) {
            return true;
          }
          deliver();
          if (disposed || now() < deadline) {
            return disposed;
          }
          const destination = new URL(
            INTEGRATION_SETTINGS_PATHS.discord,
            origin,
          );
          destination.searchParams.set("status", status);
          popup.location.href = destination.toString();
          dispose();
          onDelivered();
          return true;
        },
        250,
        signal,
        { retryTransientErrors: false, testIntervalMs: 10 },
      );
    },
    dispose,
  };
}

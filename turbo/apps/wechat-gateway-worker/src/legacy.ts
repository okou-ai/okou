import { z } from "zod";
import type { Env } from "./types";
import { signature } from "./auth";
const resultSchema = z.object({ active: z.boolean() });
export async function pollLegacyReceiver(
  storage: DurableObjectStorage,
  env: Env,
  connectionId: string,
) {
  // Schedule recovery before network I/O. A crash retries through the provider
  // alarm mechanism; the API's encrypted pending batch and event IDs own replay.
  await storage.setAlarm(Date.now() + 90_000);
  const body = JSON.stringify({ connectionId });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const origin = new URL(env.API_ORIGIN);
  if (origin.protocol !== "https:")
    throw new Error("API_ORIGIN must use HTTPS");
  const response = await fetch(new URL("/api/internal/wechat/poll", origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-wechat-timestamp": timestamp,
      "x-wechat-signature": await signature(
        env.WECHAT_GATEWAY_SECRET,
        `${timestamp}.${body}`,
      ),
    },
    body,
    signal: AbortSignal.timeout(80_000),
  });
  if (!response.ok)
    throw new Error(`WeChat receiver API returned ${response.status}`);
  const result = resultSchema.parse(await response.json());
  if (!result.active) {
    await storage.deleteAlarm();
    await storage.deleteAll();
    return;
  }
  await storage.setAlarm(Date.now() + 1_000);
}

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
interface Env {
  readonly WECHAT_RECEIVER: DurableObjectNamespace<WechatReceiver>;
  readonly WECHAT_GATEWAY_ENABLED: string;
  readonly WECHAT_GATEWAY_CONTROL_SECRET: string;
  readonly WECHAT_GATEWAY_SECRET: string;
  readonly API_ORIGIN: string;
}
const startSchema = z.object({ connectionId: z.uuid() });
const resultSchema = z.object({ active: z.boolean() });
async function signature(secret: string, text: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return Array.from(new Uint8Array(signed))
    .map((byte) => {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
}
async function controlAuthorized(request: Request, secret: string) {
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  // Compare fixed-size digests rather than a prefix-sensitive secret string.
  const expected = await signature(secret, "control");
  const actual = await signature(header.slice(7), "control");
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}
export class WechatReceiver extends DurableObject<Env> {
  async fetch(request: Request) {
    const body = startSchema.parse(await request.json());
    await this.ctx.storage.put("connectionId", body.connectionId);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 1);
    return Response.json({ ok: true });
  }
  async alarm() {
    if (this.env.WECHAT_GATEWAY_ENABLED !== "true") return;
    const connectionId = await this.ctx.storage.get<string>("connectionId");
    if (!connectionId) return;
    // Schedule recovery before network I/O. A crash retries through the provider
    // alarm mechanism; the API's encrypted pending batch and event IDs own replay.
    await this.ctx.storage.setAlarm(Date.now() + 90_000);
    const body = JSON.stringify({ connectionId });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const origin = new URL(this.env.API_ORIGIN);
    if (origin.protocol !== "https:")
      throw new Error("API_ORIGIN must use HTTPS");
    const response = await fetch(new URL("/api/internal/wechat/poll", origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wechat-timestamp": timestamp,
        "x-wechat-signature": await signature(
          this.env.WECHAT_GATEWAY_SECRET,
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
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.WECHAT_GATEWAY_ENABLED !== "true")
      return new Response("Disabled", { status: 503 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/start")
      return new Response("Not found", { status: 404 });
    if (!(await controlAuthorized(request, env.WECHAT_GATEWAY_CONTROL_SECRET)))
      return new Response("Unauthorized", { status: 401 });
    const text = await request.text();
    if (text.length > 1024) return new Response("Too large", { status: 413 });
    const parsed = startSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) return new Response("Bad request", { status: 400 });
    const actor = env.WECHAT_RECEIVER.get(
      env.WECHAT_RECEIVER.idFromName(parsed.data.connectionId),
    );
    return actor.fetch(
      new Request("https://receiver/start", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      }),
    );
  },
};

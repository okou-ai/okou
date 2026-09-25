import { z } from "zod";
import { discordGatewaySigningPayload } from "@okouai/api-contracts/contracts/discord-gateway";

export const packetSchema = z.object({
  op: z.number().int(),
  d: z.unknown(),
  s: z.number().int().nonnegative().nullable().optional(),
  t: z.string().nullable().optional(),
});

export const helloSchema = z.object({
  heartbeat_interval: z.number().int().min(100).max(120_000),
});

export const readySchema = z.object({
  session_id: z.string().min(1),
  resume_gateway_url: z.string().url(),
  application: z.object({ id: z.string() }),
  user: z.object({ id: z.string().regex(/^\d{17,20}$/u) }),
});

/** Transport-only view of a message; the API revalidates the full event. */
export const messageRoutingSchema = z.object({
  guild_id: z.string().optional(),
  mentions: z.array(z.object({ id: z.string() })).optional(),
});

export const outboxEntrySchema = z.object({
  body: z.string(),
  queuedAt: z.number(),
});

export const gatewayBotSchema = z.object({
  url: z.string().url(),
  shards: z.number().int().positive(),
  session_start_limit: z.object({
    total: z.number().int().positive(),
    remaining: z.number().int().nonnegative(),
    reset_after: z.number().int().positive(),
    max_concurrency: z.number().int().positive(),
  }),
});

export const stateSchema = z.object({
  version: z.literal(1),
  identity: z.string().nullable(),
  running: z.boolean(),
  fatal: z.string().nullable(),
  session: z
    .object({
      id: z.string(),
      url: z.string(),
      sequence: z.number().int().nonnegative(),
      botUserId: z.string(),
    })
    .nullable(),
  nextOutbox: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  reconnectAt: z.number(),
  failures: z.number().int().nonnegative(),
  identifyAt: z.number(),
  identifyRemaining: z.number().int().nonnegative(),
  identifyResetAt: z.number(),
  deliveryAt: z.number(),
  deliveryFailures: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
});

export type RelayState = z.infer<typeof stateSchema>;

export function initialState(): RelayState {
  return {
    version: 1,
    identity: null,
    running: false,
    fatal: null,
    session: null,
    nextOutbox: 0,
    pending: 0,
    reconnectAt: 0,
    failures: 0,
    identifyAt: 0,
    identifyRemaining: 0,
    identifyResetAt: 0,
    deliveryAt: 0,
    deliveryFailures: 0,
    deadLettered: 0,
  };
}

export interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace;
  DISCORD_GATEWAY_ENVIRONMENT: string;
  DISCORD_GATEWAY_ENABLED: string;
  DISCORD_GATEWAY_SHARD_ID: string;
  DISCORD_GATEWAY_SHARD_COUNT: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_GATEWAY_SECRET?: string;
  DISCORD_GATEWAY_CONTROL_SECRET?: string;
  DISCORD_API_ORIGIN?: string;
  DISCORD_GATEWAY_MESSAGE_CONTENT?: string;
}

export function relayIdentity(env: Env): string {
  return `${env.DISCORD_GATEWAY_ENVIRONMENT}:${env.DISCORD_APPLICATION_ID}:0`;
}

export function gatewayUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "wss:" ||
    !(
      url.hostname === "gateway.discord.gg" ||
      url.hostname.endsWith(".discord.gg")
    ) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("Invalid Discord Gateway URL");
  }
  url.protocol = "https:";
  url.search = "?v=10&encoding=json";
  return url.toString();
}

export function apiUrl(env: Env): string {
  if (!env.DISCORD_API_ORIGIN) throw new Error("Missing API origin");
  const url = new URL(env.DISCORD_API_ORIGIN);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid API origin");
  }
  return new URL("/api/internal/discord/gateway", url).toString();
}

export function configured(env: Env): boolean {
  const credentialsAndScopeValid = Boolean(
    env.DISCORD_GATEWAY_SHARD_ID === "0" &&
    env.DISCORD_GATEWAY_SHARD_COUNT === "1" &&
    env.DISCORD_APPLICATION_ID &&
    /^\d{17,20}$/u.test(env.DISCORD_APPLICATION_ID) &&
    env.DISCORD_BOT_TOKEN &&
    env.DISCORD_GATEWAY_SECRET &&
    env.DISCORD_GATEWAY_SECRET.length >= 32 &&
    env.DISCORD_GATEWAY_CONTROL_SECRET &&
    env.DISCORD_GATEWAY_CONTROL_SECRET.length >= 32 &&
    env.DISCORD_GATEWAY_SECRET !== env.DISCORD_GATEWAY_CONTROL_SECRET &&
    env.DISCORD_BOT_TOKEN !== env.DISCORD_GATEWAY_CONTROL_SECRET &&
    env.DISCORD_BOT_TOKEN !== env.DISCORD_GATEWAY_SECRET &&
    ["test", "production"].includes(env.DISCORD_GATEWAY_ENVIRONMENT),
  );
  if (!credentialsAndScopeValid) return false;
  try {
    apiUrl(env);
    return true;
  } catch {
    return false;
  }
}

export async function signature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(discordGatewaySigningPayload(timestamp, body)),
  );
  return [...new Uint8Array(signed)]
    .map((byte) => {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
}

export async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.DISCORD_GATEWAY_CONTROL_SECRET) return false;
  const supplied = request.headers.get("Authorization");
  if (!supplied?.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(env.DISCORD_GATEWAY_CONTROL_SECRET),
    ),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied.slice(7))),
  ]);
  const left = new Uint8Array(expected);
  const right = new Uint8Array(actual);
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function backoff(attempt: number): number {
  return (
    Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)) +
    Math.floor(Math.random() * 1000)
  );
}

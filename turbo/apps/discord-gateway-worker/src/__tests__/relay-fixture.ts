import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response,
  WebSocketPair,
  type Request,
  type WebSocket,
} from "miniflare";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";

export const APPLICATION_ID = "100000000000000001";
export const GUILD_ID = "100000000000000002";
export const CHANNEL_ID = "100000000000000003";
export const MESSAGE_ID = "100000000000000004";
export const CONTROL_SECRET = "test-gateway-control-secret-32-characters";
export const GATEWAY_SECRET = "test-api-hmac-secret-32-characters";
export const BOT_TOKEN = "test-discord-bot-token";

const packetSchema = z.object({ op: z.number(), d: z.unknown() });
type Packet = z.infer<typeof packetSchema>;

class Events<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(event: T) => void> = [];

  push(event: T): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter(event);
    else this.buffered.push(event);
  }

  async next(): Promise<T> {
    const event = this.buffered.shift();
    if (event !== undefined) return event;
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }
}

export class GatewayConnection {
  readonly client: WebSocket;
  readonly socket: WebSocket;
  readonly closed = Promise.withResolvers<{ code: number; reason: string }>();
  readonly packets: Packet[] = [];
  autoAcknowledge = true;
  private readonly incoming = new Events<Packet>();

  constructor() {
    const pair = new WebSocketPair();
    this.client = pair[0];
    this.socket = pair[1];
    this.socket.accept();
    this.socket.addEventListener("message", (event) => {
      const packet = packetSchema.parse(JSON.parse(String(event.data)));
      this.packets.push(packet);
      this.incoming.push(packet);
      if (packet.op === 1 && this.autoAcknowledge)
        this.send({ op: 11, d: null });
    });
    this.socket.addEventListener("close", (event) => {
      this.closed.resolve({ code: event.code, reason: event.reason });
    });
  }

  send(packet: object): void {
    this.socket.send(JSON.stringify(packet));
  }

  hello(interval = 10_000): void {
    this.send({ op: 10, d: { heartbeat_interval: interval } });
  }

  ready(sessionId = "discord-session", sequence = 1): void {
    this.send({
      op: 0,
      t: "READY",
      s: sequence,
      d: {
        session_id: sessionId,
        resume_gateway_url: "wss://gateway.discord.gg",
        application: { id: APPLICATION_ID },
      },
    });
  }

  message(sequence = 2, id = MESSAGE_ID): void {
    this.send({
      op: 0,
      t: "MESSAGE_CREATE",
      s: sequence,
      d: {
        id,
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author: { id: "100000000000000005", bot: false },
        content: "<@100000000000000001> Hello",
        attachments: [],
      },
    });
  }

  async next(
    op: number,
    matches?: (packet: Packet) => boolean,
  ): Promise<Packet> {
    for (;;) {
      const packet = await this.incoming.next();
      if (packet.op === op && (!matches || matches(packet))) return packet;
    }
  }
}

export interface Delivery {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  contentType: string | null;
  method: string;
}

export class RelayFixture {
  readonly connections = new Events<GatewayConnection>();
  readonly discoveries = new Events<{ authorization: string | null }>();
  readonly deliveries = new Events<Delivery>();
  readonly forwarded: Delivery[] = [];
  readonly opened: GatewayConnection[] = [];
  readonly unhandled: string[] = [];
  reply: (delivery: Delivery) => Response | Promise<Response> = () => {
    return Response.json({ ok: true, outcome: "accepted" });
  };
  gatewayMetadata = {
    url: "wss://gateway.discord.gg",
    shards: 1,
    session_start_limit: {
      total: 1000,
      remaining: 1000,
      reset_after: 86_400_000,
      max_concurrency: 1,
    },
  };
  private runtime: Miniflare;

  constructor(
    private readonly directory: string,
    private readonly bindings: Record<string, string>,
  ) {
    this.runtime = this.createRuntime();
  }

  private createRuntime(): Miniflare {
    // Miniflare owns the workerd process and real SQLite Durable Object storage.
    // Its external service boundary also supports WebSocket upgrades, unlike
    // Node HTTP interception, so HTTP and Discord frames share this handler.
    return new Miniflare(
      convertV4MiniflareOptions({
        name: "discord-relay-test",
        scriptPath: fileURLToPath(
          new URL("../../dist/index.js", import.meta.url).href,
        ),
        modules: true,
        compatibilityDate: "2026-09-01",
        cf: false,
        telemetry: { enabled: false },
        resourcePersistencePath: this.directory,
        durableObjects: {
          DISCORD_GATEWAY: { className: "DiscordGateway", useSQLite: true },
        },
        bindings: this.bindings,
        outboundService: (request) => {
          return this.handleExternalRequest(request);
        },
      }),
    );
  }

  private async handleExternalRequest(request: Request): Promise<Response> {
    if (request.url === "https://discord.com/api/v10/gateway/bot") {
      expect(request.headers.get("Authorization")).toBe(`Bot ${BOT_TOKEN}`);
      this.discoveries.push({
        authorization: request.headers.get("Authorization"),
      });
      return Response.json(this.gatewayMetadata);
    }
    if (request.url === "https://gateway.discord.gg/?v=10&encoding=json") {
      expect(request.headers.get("Upgrade")).toBe("websocket");
      const connection = new GatewayConnection();
      this.opened.push(connection);
      this.connections.push(connection);
      return new Response(null, { status: 101, webSocket: connection.client });
    }
    if (
      request.url === "https://api.example.test/api/internal/discord/gateway"
    ) {
      const delivery: Delivery = {
        rawBody: await request.text(),
        timestamp: request.headers.get("x-discord-gateway-timestamp"),
        signature: request.headers.get("x-discord-gateway-signature"),
        contentType: request.headers.get("Content-Type"),
        method: request.method,
      };
      this.forwarded.push(delivery);
      this.deliveries.push(delivery);
      return this.reply(delivery);
    }
    this.unhandled.push(`${request.method} ${request.url}`);
    return new Response("Unhandled external request", { status: 599 });
  }

  request(path: string, token: string | null = CONTROL_SECRET) {
    return this.runtime.dispatchFetch(`https://relay.example.test${path}`, {
      method: path === "/health" ? "GET" : "POST",
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
  }

  async health() {
    const response = await this.request("/health");
    expect(response.status).toBe(200);
    return response.json();
  }

  async durableObjectHealth(name: string) {
    const namespace =
      await this.runtime.getDurableObjectNamespace("DISCORD_GATEWAY");
    const response = await namespace
      .get(namespace.idFromName(name))
      .fetch("https://relay.example.test/health", {
        headers: { Authorization: `Bearer ${CONTROL_SECRET}` },
      });
    expect(response.status).toBe(200);
    return response.json();
  }

  async start(): Promise<GatewayConnection> {
    expect((await this.request("/start")).status).toBe(200);
    return this.connections.next();
  }

  async restart(bindings: Record<string, string> = {}): Promise<void> {
    await this.runtime.dispose();
    Object.assign(this.bindings, bindings);
    this.runtime = this.createRuntime();
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
    await rm(this.directory, { recursive: true, force: true });
  }
}

export async function createRelay(bindings: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "discord-gateway-test-"));
  const relay = new RelayFixture(directory, {
    DISCORD_GATEWAY_ENVIRONMENT: "test",
    DISCORD_GATEWAY_ENABLED: "true",
    DISCORD_GATEWAY_SHARD_ID: "0",
    DISCORD_GATEWAY_SHARD_COUNT: "1",
    DISCORD_GATEWAY_MESSAGE_CONTENT: "false",
    DISCORD_APPLICATION_ID: APPLICATION_ID,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_GATEWAY_SECRET: GATEWAY_SECRET,
    DISCORD_GATEWAY_CONTROL_SECRET: CONTROL_SECRET,
    DISCORD_API_ORIGIN: "https://api.example.test",
    ...bindings,
  });
  onTestFinished(async () => {
    await relay.dispose();
    expect(relay.unhandled).toEqual([]);
  });
  return relay;
}

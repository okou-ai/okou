import { z } from "zod";
import {
  discordGatewayEnvelopeSchema,
  discordGatewayReceiptSchema,
  DISCORD_GATEWAY_SIGNATURE_HEADER,
  DISCORD_GATEWAY_TIMESTAMP_HEADER,
} from "@okouai/api-contracts/contracts/discord-gateway";
import {
  apiUrl,
  authorized,
  backoff,
  configured,
  gatewayBotSchema,
  gatewayUrl,
  helloSchema,
  initialState,
  packetSchema,
  messageRoutingSchema,
  outboxEntrySchema,
  readySchema,
  relayIdentity,
  signature,
  stateSchema,
  type Env,
  type RelayState,
} from "./protocol";

const MAX_OUTBOX = 1000;
const MAX_DEAD_LETTERS = 100;
// The API will never accept these bodies, so retrying cannot succeed and
// halting would let one member's message block every other guild.
const EVENT_REJECTIONS = new Set([400, 413]);
const FATAL_CLOSES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const MAX_DURABLE_RECORD_BYTES = 120_000;
interface DeadLetter {
  readonly eventType: string;
  readonly eventId: string;
  readonly reason: string;
  readonly bytes: number;
}
const outboxKey = (index: number) => {
  return `outbox:${index.toString().padStart(16, "0")}`;
};
// Guild chatter that does not mention the bot cannot start a task, so only
// DMs and explicit mentions occupy the ordered outbox. Unparseable routing
// fields are forwarded for the API to reject.
function addressesBot(data: unknown, botUserId: string): boolean {
  const message = messageRoutingSchema.safeParse(data);
  if (!message.success) return true;
  if (message.data.guild_id === undefined) return true;
  return message.data.mentions.some((mention) => {
    return mention.id === botUserId;
  });
}
// Keyed by the cumulative dead-letter count, so eviction is oldest-first.
const deadKey = (index: number) => {
  return `dead:${index.toString().padStart(16, "0")}`;
};

// This is an outbound socket. Inbound WebSocket hibernation cannot own it.
export class DiscordGateway {
  private state: RelayState = initialState();
  private serial: Promise<void> = Promise.resolve();
  private socket: WebSocket | null = null;
  private generation = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatDeadline: number | null = null;
  private heartbeatInterval: number | null = null;
  private flushing = false;
  private deliveryAbort: AbortController | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<unknown>("state");
      this.state =
        saved === undefined ? initialState() : stateSchema.parse(saved);
      if (
        this.state.identity !== null &&
        this.state.identity !== relayIdentity(env)
      ) {
        await this.halt("configuration-scope-changed");
      }
      if (env.DISCORD_GATEWAY_ENABLED !== "true" && this.state.running) {
        await this.save({ ...this.state, running: false });
        await ctx.storage.deleteAlarm();
      }
    });
  }

  private ordered<T>(task: () => Promise<T>): Promise<T> {
    const result = this.serial.then(task);
    this.serial = result.then(
      () => {
        return undefined;
      },
      () => {
        return undefined;
      },
    );
    return result;
  }

  private async save(next: RelayState): Promise<void> {
    await this.ctx.storage.put("state", next);
    this.state = next;
  }

  private active(generation: number): boolean {
    return (
      generation === this.generation &&
      this.state.running &&
      this.env.DISCORD_GATEWAY_ENABLED === "true"
    );
  }

  private closeSocket(): void {
    this.generation++;
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    if (this.helloTimer !== null) clearTimeout(this.helloTimer);
    this.heartbeatTimer = null;
    this.helloTimer = null;
    this.heartbeatInterval = null;
    this.heartbeatDeadline = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(4000, "Relay reconnect");
  }

  private async halt(reason: string): Promise<void> {
    this.closeSocket();
    this.deliveryAbort?.abort();
    await this.save({ ...this.state, running: false, fatal: reason });
    await this.ctx.storage.deleteAlarm();
  }

  private async retry(
    clearSession = false,
    delay = backoff(this.state.failures),
  ): Promise<void> {
    this.closeSocket();
    await this.save({
      ...this.state,
      session: clearSession ? null : this.state.session,
      failures: this.state.failures + 1,
      reconnectAt: Date.now() + delay,
    });
    await this.arm();
  }

  private async arm(): Promise<void> {
    if (!this.state.running || this.env.DISCORD_GATEWAY_ENABLED !== "true") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // The durable alarm recovers isolate loss; timers only maintain the live socket.
    const recovery = Date.now() + 30_000;
    const connect =
      this.socket || this.state.pending >= MAX_OUTBOX
        ? recovery
        : Math.max(Date.now() + 100, this.state.reconnectAt);
    const delivery =
      this.state.pending > 0 && !this.flushing
        ? Math.max(Date.now() + 100, this.state.deliveryAt)
        : recovery;
    await this.ctx.storage.setAlarm(Math.min(recovery, connect, delivery));
  }

  async fetch(request: Request): Promise<Response> {
    if (!(await authorized(request, this.env)))
      return new Response("Unauthorized", { status: 401 });
    return this.ordered(async () => {
      const path = new URL(request.url).pathname;
      if (path === "/stop" && request.method === "POST") {
        this.closeSocket();
        this.deliveryAbort?.abort();
        await this.save({ ...this.state, running: false });
        await this.ctx.storage.deleteAlarm();
        return await this.health();
      }
      if (path === "/health" && request.method === "GET")
        return await this.health();
      if (path === "/dead-letters" && request.method === "GET") {
        const records = await this.ctx.storage.list<DeadLetter>({
          prefix: "dead:",
        });
        return Response.json(
          { deadLetters: [...records.values()] },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (path !== "/start" || request.method !== "POST")
        return new Response("Not found", { status: 404 });
      if (this.env.DISCORD_GATEWAY_ENABLED !== "true")
        return new Response("Gateway disabled", { status: 409 });
      if (!configured(this.env))
        return new Response("Gateway configuration incomplete", {
          status: 503,
        });
      if (
        this.state.identity !== null &&
        this.state.identity !== relayIdentity(this.env)
      ) {
        return new Response(
          "Stored Gateway belongs to another application/environment",
          { status: 409 },
        );
      }
      if (!this.state.running) {
        await this.save({
          ...this.state,
          identity: relayIdentity(this.env),
          running: true,
          fatal: null,
          reconnectAt: Date.now(),
          deliveryAt: Date.now(),
        });
      }
      await this.arm();
      return await this.health();
    });
  }

  private async health(): Promise<Response> {
    const oldest = await this.ctx.storage.list<unknown>({
      prefix: "outbox:",
      limit: 1,
    });
    const [head] = oldest.values();
    return Response.json(
      {
        enabled: this.env.DISCORD_GATEWAY_ENABLED === "true",
        running: this.state.running,
        connected: this.socket !== null,
        resumable: this.state.session !== null,
        pending: this.state.pending,
        deadLettered: this.state.deadLettered,
        deliveryFailures: this.state.deliveryFailures,
        oldestPendingAgeMs:
          head === undefined
            ? null
            : Math.max(0, Date.now() - outboxEntrySchema.parse(head).queuedAt),
        fatal: this.state.fatal,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  async alarm(): Promise<void> {
    await this.ordered(async () => {
      if (this.env.DISCORD_GATEWAY_ENABLED !== "true") {
        this.closeSocket();
        await this.save({ ...this.state, running: false });
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (!this.state.running) return;
      if (!configured(this.env)) {
        await this.halt("configuration");
        return;
      }
      // Arm before external I/O. A process crash cannot strand a committed outbox.
      await this.arm();
      if (
        !this.socket &&
        Date.now() >= this.state.reconnectAt &&
        this.state.pending < MAX_OUTBOX
      ) {
        try {
          await this.connect();
        } catch {
          await this.retry();
        }
      }
    });
    this.startFlush();
  }

  private async identifyGateway(): Promise<string | null> {
    if (Date.now() < this.state.identifyAt) {
      await this.save({ ...this.state, reconnectAt: this.state.identifyAt });
      return null;
    }
    const response = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (response.status === 401 || response.status === 403) {
      await this.halt("gateway-authentication");
      return null;
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      await response.body?.cancel();
      await this.retry(
        false,
        Math.max(
          backoff(this.state.failures),
          Number.isFinite(retryAfter)
            ? Math.min(3_600_000, retryAfter * 1000)
            : 0,
        ),
      );
      return null;
    }
    if (!response.ok) throw new Error("Gateway discovery failed");
    // `shards` is only Discord's recommendation. When sharding is actually
    // required, Discord closes the connection with fatal code 4011.
    const metadata = gatewayBotSchema.parse(await response.json());
    const limit = metadata.session_start_limit;
    const activeBudget = Date.now() < this.state.identifyResetAt;
    const remaining = activeBudget
      ? Math.min(this.state.identifyRemaining, limit.remaining)
      : limit.remaining;
    const resetAt = Math.max(
      this.state.identifyResetAt,
      Date.now() + limit.reset_after,
    );
    if (remaining === 0) {
      await this.save({
        ...this.state,
        identifyRemaining: 0,
        identifyResetAt: resetAt,
        reconnectAt: resetAt,
      });
      return null;
    }
    // Reserve before any Identify reaches Discord, including response-loss/restart.
    await this.save({
      ...this.state,
      identifyRemaining: remaining - 1,
      identifyResetAt: resetAt,
      identifyAt: Date.now() + 5000,
    });
    return gatewayUrl(metadata.url);
  }

  private async connect(): Promise<void> {
    const url = this.state.session
      ? gatewayUrl(this.state.session.url)
      : await this.identifyGateway();
    if (!url || !this.state.running) {
      await this.arm();
      return;
    }
    const response = await fetch(url, {
      headers: { Upgrade: "websocket" },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    const socket = response.webSocket;
    if (response.status !== 101 || !socket)
      throw new Error("Gateway upgrade failed");
    const generation = ++this.generation;
    this.socket = socket;
    this.heartbeatDeadline = null;
    socket.accept();
    socket.addEventListener("message", (event) => {
      if (!this.active(generation)) return;
      try {
        if (typeof event.data !== "string")
          throw new Error("Unexpected Gateway binary frame");
        const packet = packetSchema.parse(JSON.parse(event.data));
        if (packet.op === 11) {
          this.heartbeatDeadline = null;
          return;
        }
        if (packet.op === 1) {
          this.sendHeartbeat(generation);
          return;
        }
        this.ctx.waitUntil(
          this.ordered(async () => {
            if (this.active(generation)) await this.packet(packet, generation);
          }).catch(async () => {
            await this.ordered(async () => {
              if (this.active(generation))
                await this.halt("invalid-gateway-event-or-storage-failure");
            });
          }),
        );
      } catch {
        this.ctx.waitUntil(
          this.ordered(async () => {
            if (this.active(generation))
              await this.halt("invalid-gateway-frame");
          }),
        );
      }
    });
    socket.addEventListener("close", (event) => {
      this.ctx.waitUntil(
        this.ordered(async () => {
          if (!this.active(generation)) return;
          if (FATAL_CLOSES.has(event.code)) {
            await this.halt(`gateway-close-${event.code}`);
            return;
          }
          await this.retry([4007, 4009].includes(event.code));
        }),
      );
    });
    socket.addEventListener("error", () => {
      this.ctx.waitUntil(
        this.ordered(async () => {
          if (this.active(generation)) await this.retry();
        }),
      );
    });
    this.helloTimer = setTimeout(() => {
      this.ctx.waitUntil(
        this.ordered(async () => {
          if (this.active(generation)) await this.retry();
        }),
      );
    }, 15_000);
    await this.arm();
  }

  private sendHeartbeat(generation: number): void {
    if (
      !this.active(generation) ||
      !this.socket ||
      this.heartbeatInterval === null
    )
      return;
    try {
      this.socket.send(
        JSON.stringify({ op: 1, d: this.state.session?.sequence ?? null }),
      );
      this.heartbeatDeadline ??= Date.now() + this.heartbeatInterval;
    } catch {
      this.ctx.waitUntil(
        this.ordered(async () => {
          if (this.active(generation)) await this.retry();
        }),
      );
    }
  }

  private heartbeat(generation: number, interval: number): void {
    if (!this.active(generation)) return;
    if (
      this.heartbeatDeadline !== null &&
      Date.now() >= this.heartbeatDeadline
    ) {
      this.ctx.waitUntil(
        this.ordered(async () => {
          if (this.active(generation)) await this.retry();
        }),
      );
      return;
    }
    this.sendHeartbeat(generation);
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeat(generation, interval);
    }, interval);
  }

  private async packet(
    packet: z.infer<typeof packetSchema>,
    generation: number,
  ): Promise<void> {
    switch (packet.op) {
      case 10: {
        const { heartbeat_interval: interval } = helloSchema.parse(packet.d);
        this.heartbeatInterval = interval;
        if (this.heartbeatTimer !== null)
          throw new Error("Repeated Gateway Hello");
        if (this.helloTimer !== null) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.heartbeatTimer = setTimeout(
          () => {
            this.heartbeat(generation, interval);
          },
          Math.floor(Math.random() * interval),
        );
        const session = this.state.session;
        if (!session)
          await this.save({ ...this.state, identifyAt: Date.now() + 5000 });
        this.socket?.send(
          JSON.stringify(
            session
              ? {
                  op: 6,
                  d: {
                    token: this.env.DISCORD_BOT_TOKEN,
                    session_id: session.id,
                    seq: session.sequence,
                  },
                }
              : {
                  op: 2,
                  d: {
                    token: this.env.DISCORD_BOT_TOKEN,
                    intents:
                      4609 +
                      (this.env.DISCORD_GATEWAY_MESSAGE_CONTENT === "true"
                        ? 32768
                        : 0),
                    properties: {
                      os: "linux",
                      browser: "okou",
                      device: "okou",
                    },
                    shard: [0, 1],
                  },
                },
          ),
        );
        return;
      }
      case 7:
        await this.retry(false, 1000);
        return;
      case 9:
        await this.retry(
          !z.boolean().parse(packet.d),
          1000 + Math.floor(Math.random() * 4000),
        );
        return;
      case 0:
        await this.dispatch(packet);
        return;
      default:
        return;
    }
  }

  private async dispatch(packet: z.infer<typeof packetSchema>): Promise<void> {
    if (packet.s === null || packet.s === undefined || !packet.t)
      throw new Error("Invalid dispatch");
    let session = this.state.session;
    if (packet.t === "READY") {
      const ready = readySchema.parse(packet.d);
      gatewayUrl(ready.resume_gateway_url);
      if (ready.application.id !== this.env.DISCORD_APPLICATION_ID) {
        await this.halt("application-mismatch");
        return;
      }
      session = {
        id: ready.session_id,
        url: ready.resume_gateway_url,
        sequence: packet.s,
        botUserId: ready.user.id,
      };
    } else {
      if (!session) throw new Error("Dispatch before Ready");
      if (packet.s <= session.sequence) return;
      session = { ...session, sequence: packet.s };
    }
    const forwarded =
      packet.t === "GUILD_DELETE" ||
      (packet.t === "MESSAGE_CREATE" &&
        addressesBot(packet.d, session.botUserId));
    if (forwarded && this.state.pending >= MAX_OUTBOX) {
      await this.retry(false, 5000);
      return;
    }
    const next = { ...this.state, session, failures: 0 };
    const payload = forwarded
      ? z.record(z.string(), z.unknown()).parse(packet.d)
      : null;
    if (payload) {
      const id = z
        .string()
        .regex(/^\d{17,20}$/u)
        .parse(payload.id);
      const envelope = discordGatewayEnvelopeSchema.parse({
        version: 1,
        applicationId: this.env.DISCORD_APPLICATION_ID,
        eventType: packet.t,
        eventId:
          packet.t === "MESSAGE_CREATE"
            ? `MESSAGE_CREATE:${id}`
            : `GUILD_DELETE:${session.id}:${packet.s}`,
        payload,
      });
      const body = JSON.stringify(envelope);
      const bytes = new TextEncoder().encode(body).byteLength;
      next.nextOutbox++;
      if (bytes > MAX_DURABLE_RECORD_BYTES) {
        // Discord replays this event on every resume, so halting would stall
        // every guild. Checkpoint past it and keep only a reference record.
        next.deadLettered++;
        const evicted = await this.deadLetterEviction();
        const record = {
          eventType: envelope.eventType,
          eventId: envelope.eventId,
          reason: "exceeds-durable-record-limit",
          bytes,
        } satisfies DeadLetter;
        await this.ctx.storage.transaction(async (transaction) => {
          if (evicted !== undefined) await transaction.delete(evicted);
          await transaction.put(deadKey(this.state.deadLettered), record);
          await transaction.put("state", next);
        });
      } else {
        next.pending++;
        await this.ctx.storage.transaction(async (transaction) => {
          await transaction.put(outboxKey(this.state.nextOutbox), {
            body,
            queuedAt: Date.now(),
          });
          await transaction.put("state", next);
        });
      }
      this.state = next;
    } else {
      await this.save(next);
    }
    await this.arm();
    this.startFlush();
  }

  private startFlush(): void {
    if (
      this.flushing ||
      !this.state.running ||
      this.env.DISCORD_GATEWAY_ENABLED !== "true" ||
      this.state.pending === 0 ||
      Date.now() < this.state.deliveryAt
    )
      return;
    this.flushing = true;
    this.ctx.waitUntil(
      this.flush().finally(async () => {
        this.flushing = false;
        await this.ordered(async () => {
          await this.arm();
        });
      }),
    );
  }

  private async flush(): Promise<void> {
    // Bounded network work never holds the Gateway dispatch/heartbeat queue.
    for (let sent = 0; sent < 20 && this.state.running; sent++) {
      const entries = await this.ctx.storage.list<unknown>({
        prefix: "outbox:",
        limit: 1,
      });
      const entry = entries.entries().next().value;
      if (
        !entry ||
        !this.state.running ||
        this.env.DISCORD_GATEWAY_ENABLED !== "true"
      )
        return;
      const [key, value] = entry;
      const { body } = outboxEntrySchema.parse(value);
      const secret = this.env.DISCORD_GATEWAY_SECRET;
      if (!secret) return;
      const timestamp = Math.floor(Date.now() / 1000).toString();
      let status = 0;
      let retryAfter = 0;
      let accepted = false;
      let invalidReceipt = false;
      try {
        const signed = await signature(secret, timestamp, body);
        if (!this.state.running) return;
        this.deliveryAbort = new AbortController();
        const response = await fetch(apiUrl(this.env), {
          method: "POST",
          body,
          redirect: "manual",
          signal: AbortSignal.any([
            this.deliveryAbort.signal,
            AbortSignal.timeout(10_000),
          ]),
          headers: {
            "Content-Type": "application/json",
            [DISCORD_GATEWAY_TIMESTAMP_HEADER]: timestamp,
            [DISCORD_GATEWAY_SIGNATURE_HEADER]: signed,
          },
        });
        status = response.status;
        const seconds = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(seconds) && seconds > 0)
          retryAfter = Math.min(3_600_000, seconds * 1000);
        if (status === 200) {
          const text = await response.text();
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* A non-JSON success body is an invalid receipt. */
          }
          const receipt = discordGatewayReceiptSchema.safeParse(json);
          accepted = receipt.success;
          invalidReceipt = !receipt.success;
        } else {
          invalidReceipt = status >= 200 && status < 300;
          await response.body?.cancel();
        }
      } catch {
        /* Delivery uncertainty retains the exact durable envelope. */
      } finally {
        this.deliveryAbort = null;
      }
      await this.ordered(async () => {
        if (accepted) {
          const next = {
            ...this.state,
            pending: this.state.pending - 1,
            deliveryFailures: 0,
            deliveryAt: 0,
          };
          await this.ctx.storage.transaction(async (transaction) => {
            await transaction.delete(key);
            await transaction.put("state", next);
          });
          this.state = next;
        } else if (invalidReceipt) {
          await this.halt("api-invalid-receipt");
        } else if (EVENT_REJECTIONS.has(status)) {
          await this.deadLetter(key, body, status);
        } else if (
          status >= 400 &&
          status < 500 &&
          status !== 408 &&
          status !== 429
        ) {
          await this.halt(`api-rejected-${status}`);
        } else {
          await this.save({
            ...this.state,
            deliveryFailures: this.state.deliveryFailures + 1,
            deliveryAt:
              Date.now() +
              Math.max(retryAfter, backoff(this.state.deliveryFailures)),
          });
        }
        await this.arm();
      });
      if (!accepted && !EVENT_REJECTIONS.has(status)) return;
    }
  }

  // Retains bounded, content-free references for operator diagnosis; Durable
  // Object storage is outside account erasure, so message bodies stay out.
  // Returns the oldest record to drop so retention stays bounded.
  private async deadLetterEviction(): Promise<string | undefined> {
    if (this.state.deadLettered < MAX_DEAD_LETTERS) return undefined;
    const oldest = await this.ctx.storage.list<string>({
      prefix: "dead:",
      limit: 1,
    });
    const [evicted] = oldest.keys();
    return evicted;
  }

  private async deadLetter(
    key: string,
    body: string,
    status: number,
  ): Promise<void> {
    const evicted = await this.deadLetterEviction();
    const envelope = discordGatewayEnvelopeSchema.parse(JSON.parse(body));
    const record = {
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      reason: `api-rejected-${status}`,
      bytes: new TextEncoder().encode(body).byteLength,
    } satisfies DeadLetter;
    const next = {
      ...this.state,
      pending: this.state.pending - 1,
      deliveryFailures: 0,
      deliveryAt: 0,
      deadLettered: this.state.deadLettered + 1,
    };
    await this.ctx.storage.transaction(async (transaction) => {
      if (evicted !== undefined) await transaction.delete(evicted);
      await transaction.delete(key);
      await transaction.put(deadKey(this.state.deadLettered), record);
      await transaction.put("state", next);
    });
    this.state = next;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await authorized(request, env)))
      return new Response("Unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (
      !(
        (["/health", "/dead-letters"].includes(path) &&
          request.method === "GET") ||
        (["/start", "/stop"].includes(path) && request.method === "POST")
      )
    )
      return new Response("Not found", { status: 404 });
    if (
      !env.DISCORD_APPLICATION_ID ||
      !["test", "production"].includes(env.DISCORD_GATEWAY_ENVIRONMENT) ||
      env.DISCORD_GATEWAY_SHARD_ID !== "0" ||
      env.DISCORD_GATEWAY_SHARD_COUNT !== "1"
    )
      return new Response("Gateway configuration incomplete", { status: 503 });
    const id = env.DISCORD_GATEWAY.idFromName(relayIdentity(env));
    return env.DISCORD_GATEWAY.get(id).fetch(request);
  },
};

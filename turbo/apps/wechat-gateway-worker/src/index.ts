import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { receiveWechatBlock } from "./workflow";
import { boolean, object, string, uuid } from "zod";
import { controlAuthorized } from "./auth";
import { wechatUpdatesSchema } from "@okouai/api-contracts/contracts/wechat-protocol";
import { saveReceiver, readPendingBatch } from "./pending";
import { seal } from "./crypto";
import {
  LEASE_MS,
  type Env,
  type ReceiverState,
  type ReceiverParams,
} from "./types";

const stopSchema = object({
  connectionId: uuid(),
});
const startSchema = stopSchema.extend({ generation: uuid() });
export class WechatReceiver extends DurableObject<Env> {
  async fetch(request: Request) {
    const raw: unknown = await request.json();
    return this.ctx.blockConcurrencyWhile(async () => {
      if (new URL(request.url).pathname === "/stop") {
        stopSchema.parse(raw);
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        return Response.json({ ok: true });
      }
      const body = startSchema.parse(raw);
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put("connectionId", body.connectionId);
        const state = await txn.get<ReceiverState>("receiver");
        const hint = await txn.get<string>("generationHint");
        if (body.generation !== hint) {
          await txn.put("generationHint", body.generation);
          if (state) await txn.put("receiver", { ...state, leaseUntil: 0 });
          await txn.setAlarm(Date.now() + 1);
        } else if ((await txn.getAlarm()) === null) {
          await txn.setAlarm(Date.now() + 1);
        }
      });
      return Response.json({ ok: true });
    });
  }
  async alarm() {
    if (this.env.WECHAT_GATEWAY_ENABLED !== "true") return;
    const launch = await this.ctx.blockConcurrencyWhile(async () => {
      const connectionId = await this.ctx.storage.get<string>("connectionId");
      if (!connectionId) return null;
      const saved = await this.ctx.storage.get<ReceiverState>("receiver");
      if (saved && saved.leaseUntil > Date.now()) {
        await this.ctx.storage.setAlarm(
          saved.started ? saved.leaseUntil : Date.now() + 5_000,
        );
        return saved.started ? null : { state: saved, connectionId };
      }
      const state: ReceiverState = {
        ...saved,
        ownerId: crypto.randomUUID(),
        leaseUntil: Date.now() + LEASE_MS,
        started: false,
        cursor: saved?.cursor ?? "",
      };
      // Ownership and its recovery alarm must survive or roll back together.
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put("receiver", state);
        await txn.setAlarm(Date.now() + 5_000);
      });
      return { state, connectionId };
    });
    if (!launch) return;
    const { state, connectionId } = launch;
    try {
      await this.env.WECHAT_POLL_WORKFLOW.create({
        id: state.ownerId,
        params: { connectionId, ownerId: state.ownerId },
      });
    } catch (error) {
      // Only an existing instance proves that the create already committed.
      const instance = await this.env.WECHAT_POLL_WORKFLOW.get(state.ownerId);
      const status = await instance.status();
      if (status.status === "unknown") throw error;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<ReceiverState>("receiver");
      if (!this.live(current, state.ownerId)) return;
      await this.ctx.storage.put("receiver", { ...current, started: true });
      await this.ctx.storage.setAlarm(current.leaseUntil);
    });
  }
  async open(ownerId: string) {
    const state = await this.ctx.storage.get<ReceiverState>("receiver");
    return this.live(state, ownerId) ? state : null;
  }
  private live(
    state: ReceiverState | undefined,
    ownerId: string,
  ): state is ReceiverState {
    return (
      this.env.WECHAT_GATEWAY_ENABLED === "true" &&
      state?.ownerId === ownerId &&
      state.leaseUntil > Date.now()
    );
  }
  async renew(ownerId: string, stream: ReadableStream | null) {
    const session = stream
      ? object({
          generation: uuid(),
          baseUrl: string(),
          token: string(),
          cursor: string(),
          preserveCursor: boolean(),
          pending: wechatUpdatesSchema.nullable(),
        }).parse(await new Response(stream).json())
      : undefined;
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<ReceiverState>("receiver");
      const connectionId = await this.ctx.storage.get<string>("connectionId");
      if (!this.live(state, ownerId) || !connectionId) return null;
      let next = state;
      if (session) {
        next = {
          ...state,
          generation: session.generation,
          session: await seal(
            this.env.WECHAT_RECEIVER_ENCRYPTION_KEY,
            connectionId,
            {
              generation: session.generation,
              baseUrl: session.baseUrl,
              token: session.token,
            },
          ),
          cursor:
            session.preserveCursor && state.session
              ? state.cursor
              : session.cursor,
          pending: undefined,
        };
      }
      next = { ...next, leaseUntil: Date.now() + LEASE_MS };
      next = await saveReceiver(
        this.ctx.storage,
        this.env.WECHAT_RECEIVER_ENCRYPTION_KEY,
        connectionId,
        state,
        next,
        session?.pending,
      );
      await this.ctx.storage.setAlarm(next.leaseUntil);
      return next;
    });
  }
  async checkpoint(
    ownerId: string,
    cursor: string,
    stream: ReadableStream | null,
  ) {
    const updates = stream
      ? wechatUpdatesSchema.parse(await new Response(stream).json())
      : null;
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<ReceiverState>("receiver");
      const connectionId = await this.ctx.storage.get<string>("connectionId");
      if (!this.live(state, ownerId) || !connectionId) return null;
      if (state.cursor !== cursor || state.pending) return state;
      const nextCursor = updates?.get_updates_buf ?? cursor;
      const hasMessages = !!updates?.msgs?.length;
      if (!hasMessages && nextCursor === cursor) return state;
      const next: ReceiverState = {
        ...state,
        cursor: nextCursor,
        pending: undefined,
      };
      // The cursor and batch share one atomic storage write.
      return saveReceiver(
        this.ctx.storage,
        this.env.WECHAT_RECEIVER_ENCRYPTION_KEY,
        connectionId,
        state,
        next,
        updates,
      );
    });
  }
  async readPending(ownerId: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.open(ownerId);
      if (!state?.pending) return null;
      return readPendingBatch(this.ctx.storage, state.pending);
    });
  }
  async acknowledge(ownerId: string, batchId: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<ReceiverState>("receiver");
      if (!this.live(state, ownerId)) return null;
      if (state.pending?.id !== batchId) return state;
      const next = { ...state, pending: undefined };
      return saveReceiver(
        this.ctx.storage,
        this.env.WECHAT_RECEIVER_ENCRYPTION_KEY,
        "",
        state,
        next,
        null,
      );
    });
  }
  async finish(ownerId: string, restart: boolean, delayMs = 1) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<ReceiverState>("receiver");
      if (!this.live(state, ownerId)) return;
      if (restart) {
        await this.ctx.storage.transaction(async (txn) => {
          await txn.put("receiver", { ...state, leaseUntil: 0 });
          await txn.setAlarm(Date.now() + delayMs);
        });
      } else {
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
      }
    });
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/stop" && env.WECHAT_GATEWAY_ENABLED !== "true")
      return new Response("Disabled", { status: 503 });
    if (request.method !== "POST" || !["/start", "/stop"].includes(path))
      return new Response("Not found", { status: 404 });
    if (!(await controlAuthorized(request, env.WECHAT_GATEWAY_CONTROL_SECRET)))
      return new Response("Unauthorized", { status: 401 });
    const text = await request.text();
    if (text.length > 1024) return new Response("Too large", { status: 413 });
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const parsed = (path === "/stop" ? stopSchema : startSchema).safeParse(raw);
    if (!parsed.success) return new Response("Bad request", { status: 400 });
    const actor = env.WECHAT_RECEIVER.get(
      env.WECHAT_RECEIVER.idFromName(parsed.data.connectionId),
    );
    return actor.fetch(
      new Request(`https://receiver${path}`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      }),
    );
  },
};

export class WechatPollWorkflow extends WorkflowEntrypoint<
  Env,
  ReceiverParams
> {
  async run(event: WorkflowEvent<ReceiverParams>, step: WorkflowStep) {
    try {
      for (let block = 0; block < 6; block++) {
        const active = await step.do(
          `receive-${block}`,
          {
            timeout: "11 minutes",
            retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          },
          () => {
            return receiveWechatBlock(this.env, event.payload);
          },
        );
        if (!active) return;
      }
      await step.do("continue-receiving", async () => {
        const actor = this.env.WECHAT_RECEIVER.get(
          this.env.WECHAT_RECEIVER.idFromName(event.payload.connectionId),
        );
        await actor.finish(event.payload.ownerId, true);
      });
    } catch (error) {
      const actor = this.env.WECHAT_RECEIVER.get(
        this.env.WECHAT_RECEIVER.idFromName(event.payload.connectionId),
      );
      await actor.finish(event.payload.ownerId, true, 90_000);
      throw error;
    }
  }
}

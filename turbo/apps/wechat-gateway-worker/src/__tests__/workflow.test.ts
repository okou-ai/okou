import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath, URL as NodeURL } from "node:url";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response,
  type Request,
} from "miniflare";
import { expect, it, onTestFinished } from "vitest";
import { array, literal, number, object, string } from "zod";
const connectionId = "00000000-0000-4000-8000-000000000001";
const generation = "00000000-0000-4000-8000-000000000002";
const secret = randomUUID();
const control = randomUUID();
const updatesSchema = object({
  connectionId: literal(connectionId),
  generation: literal(generation),
  updates: object({
    get_updates_buf: string(),
    msgs: array(
      object({
        message_id: string(),
        item_list: array(
          object({
            type: number(),
            text_item: object({ text: string() }),
          }),
        ),
      }),
    ),
  }),
});
function fixture(handler: (request: Request) => Promise<Response>) {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: "wechat-workflow-test",
      scriptPath: fileURLToPath(
        new NodeURL("../../dist/index.js", import.meta.url),
      ),
      modules: true,
      compatibilityDate: "2026-09-03",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      telemetry: { enabled: false },
      durableObjects: {
        WECHAT_RECEIVER: { className: "WechatReceiver", useSQLite: true },
      },
      workflows: {
        WECHAT_POLL_WORKFLOW: {
          name: "wechat-poll-test",
          className: "WechatPollWorkflow",
        },
      },
      bindings: {
        WECHAT_GATEWAY_ENABLED: "true",
        WECHAT_GATEWAY_SECRET: secret,
        WECHAT_RECEIVER_ENCRYPTION_KEY: randomUUID(),
        WECHAT_GATEWAY_CONTROL_SECRET: control,
        API_ORIGIN: "https://api.example.test",
      },
      outboundService: async (request) => {
        if (new URL(request.url).hostname === "api.example.test") {
          const body = await request.clone().text();
          expect(request.headers.get("x-wechat-signature")).toBe(
            createHmac("sha256", secret)
              .update(`${request.headers.get("x-wechat-timestamp")}.${body}`)
              .digest("hex"),
          );
        }
        return handler(request);
      },
    }),
  );
  onTestFinished(() => {
    return runtime.dispose();
  });
  return {
    start: (nextGeneration = generation) => {
      return runtime.dispatchFetch("https://worker/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${control}` },
        body: JSON.stringify({ connectionId, generation: nextGeneration }),
      });
    },
  };
}
function bootstrap() {
  return Response.json({
    active: true,
    generation,
    session: {
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "private-provider-token",
      cursor: "saved-cursor",
      preserveCursor: false,
      pending: null,
    },
  });
}
it("receives in a Workflow, checkpoints empty cursors and dispatches messages without idle API polls", async () => {
  const expired = Promise.withResolvers<void>();
  const requests: string[] = [];
  let polls = 0;
  const runtime = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/api/internal/wechat/receiver") return bootstrap();
    if (path === "/ilink/bot/getupdates") {
      expect(request.headers.get("Authorization")).toBe(
        "Bearer private-provider-token",
      );
      const body = object({ get_updates_buf: string() }).parse(
        await request.json(),
      );
      polls++;
      expect(body.get_updates_buf).toBe(
        ["saved-cursor", "empty-cursor", "message-cursor"][polls - 1],
      );
      if (polls === 1)
        return Response.json({ get_updates_buf: "empty-cursor", msgs: [] });
      if (polls === 2)
        return new Response(
          '{"get_updates_buf":"message-cursor","msgs":[{"message_id":18446744073709551615,"from_user_id":"scanner","message_type":1,"item_list":[{"type":1,"text_item":{"text":"hello"}}]}]}',
          { headers: { "Content-Type": "application/json" } },
        );
      return Response.json({ ret: -14 });
    }
    if (path === "/api/internal/wechat/deliver") {
      const body = updatesSchema.parse(await request.json());
      expect(body.updates.msgs[0]?.message_id).toBe("18446744073709551615");
      return Response.json({ active: true });
    }
    if (path === "/api/internal/wechat/expire") {
      expired.resolve();
      return Response.json({ active: false });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  expect((await runtime.start()).status).toBe(200);
  await expired.promise;
  expect(requests).toEqual([
    "/api/internal/wechat/receiver",
    "/ilink/bot/getupdates",
    "/ilink/bot/getupdates",
    "/api/internal/wechat/deliver",
    "/ilink/bot/getupdates",
    "/api/internal/wechat/expire",
  ]);
}, 30_000);
it("replays a saved batch larger than the RPC limit after an ambiguous delivery without polling past it", async () => {
  const completed = Promise.withResolvers<void>();
  const text = "x".repeat(1_200_000);
  let polls = 0;
  let deliveries = 0;
  const runtime = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/internal/wechat/receiver") {
      const body = object({ generation: string().optional() }).parse(
        await request.json(),
      );
      return body.generation
        ? Response.json({ active: true, generation })
        : bootstrap();
    }
    if (path === "/ilink/bot/getupdates") {
      polls++;
      return Response.json({
        get_updates_buf: "next",
        msgs: [
          {
            message_id: "1",
            from_user_id: "scanner",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text } }],
          },
        ],
      });
    }
    if (path === "/api/internal/wechat/deliver") {
      const body = updatesSchema.parse(await request.json());
      expect(body.updates.msgs[0]?.item_list[0]?.text_item.text).toBe(text);
      deliveries++;
      if (deliveries === 1)
        return new Response("Response lost", { status: 503 });
      completed.resolve();
      return Response.json({ active: false });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  expect((await runtime.start()).status).toBe(200);
  await completed.promise;
  expect(polls).toBe(1);
  expect(deliveries).toBe(2);
}, 30_000);

it("fences a superseded long poll when a verified binding is replaced", async () => {
  const oldPoll = Promise.withResolvers<void>();
  const releaseOld = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const nextGeneration = "00000000-0000-4000-8000-000000000003";
  let currentGeneration = generation;
  let nextPolls = 0;
  const delivered: string[] = [];
  const runtime = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/internal/wechat/receiver") {
      return Response.json({
        active: true,
        generation: currentGeneration,
        session: {
          baseUrl: "https://ilinkai.weixin.qq.com",
          token: currentGeneration,
          cursor: "initial",
          preserveCursor: false,
          pending: null,
        },
      });
    }
    if (path === "/ilink/bot/getupdates") {
      if (request.headers.get("authorization") === `Bearer ${generation}`) {
        oldPoll.resolve();
        await releaseOld.promise;
        return Response.json({
          get_updates_buf: "stale",
          msgs: [
            { message_id: "stale", from_user_id: "scanner", message_type: 1 },
          ],
        });
      }
      releaseOld.resolve();
      nextPolls++;
      const body = object({ get_updates_buf: string() }).parse(
        await request.json(),
      );
      expect(body.get_updates_buf).toBe(
        nextPolls === 1 ? "initial" : "replacement",
      );
      return nextPolls === 1
        ? Response.json({
            get_updates_buf: "replacement",
            msgs: [
              {
                message_id: "replacement",
                from_user_id: "scanner",
                message_type: 1,
              },
            ],
          })
        : Response.json({ ret: -14 });
    }
    if (path === "/api/internal/wechat/deliver") {
      const body = object({
        generation: literal(nextGeneration),
        updates: object({
          msgs: array(object({ message_id: string() })),
        }),
      }).parse(await request.json());
      delivered.push(
        ...body.updates.msgs.map((message) => {
          return message.message_id;
        }),
      );
      return Response.json({ active: true });
    }
    if (path === "/api/internal/wechat/expire") {
      completed.resolve();
      return Response.json({ active: false });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  onTestFinished(() => {
    releaseOld.resolve();
  });
  expect((await runtime.start()).status).toBe(200);
  await oldPoll.promise;
  currentGeneration = nextGeneration;
  expect((await runtime.start(nextGeneration)).status).toBe(200);
  await completed.promise;
  expect(delivered).toEqual(["replacement"]);
}, 30_000);

it("continues with the saved cursor when a provider long poll reaches its own deadline", async () => {
  const completed = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<Response>();
  let polls = 0;
  let renewals = 0;
  const runtime = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/internal/wechat/receiver") {
      renewals++;
      return bootstrap();
    }
    if (path === "/ilink/bot/getupdates") {
      const body = object({ get_updates_buf: string() }).parse(
        await request.json(),
      );
      expect(body.get_updates_buf).toBe("saved-cursor");
      polls++;
      if (polls === 1) return idle.promise;
      return Response.json({ ret: -14 });
    }
    if (path === "/api/internal/wechat/expire") {
      completed.resolve();
      return Response.json({ active: false });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  onTestFinished(() => {
    idle.resolve(Response.json({ msgs: [] }));
  });
  expect((await runtime.start()).status).toBe(200);
  await completed.promise;
  expect(polls).toBe(2);
  expect(renewals).toBe(1);
}, 60_000);

it("retains a batch while the API retries an individual input and polls only after acknowledgement", async () => {
  const completed = Promise.withResolvers<void>();
  let polls = 0;
  let deliveries = 0;
  const runtime = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/internal/wechat/receiver") return bootstrap();
    if (path === "/ilink/bot/getupdates") {
      polls++;
      if (polls === 2) {
        expect(deliveries).toBe(3);
        const body = object({ get_updates_buf: string() }).parse(
          await request.json(),
        );
        expect(body.get_updates_buf).toBe("retry-cursor");
        return Response.json({ ret: -14 });
      }
      return Response.json({
        get_updates_buf: "retry-cursor",
        msgs: [
          { message_id: "malformed" },
          {
            message_id: "retry-message",
            from_user_id: "scanner",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "hello" } }],
          },
        ],
      });
    }
    if (path === "/api/internal/wechat/deliver") {
      const body = updatesSchema.parse(await request.json());
      expect(
        body.updates.msgs.map((message) => {
          return message.message_id;
        }),
      ).toEqual(["retry-message"]);
      expect(polls).toBe(1);
      deliveries++;
      return Response.json(
        deliveries < 3
          ? { active: true, retryAfterMs: 1_000 }
          : { active: true },
      );
    }
    if (path === "/api/internal/wechat/expire") {
      completed.resolve();
      return Response.json({ active: false });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  expect((await runtime.start()).status).toBe(200);
  await completed.promise;
  expect(deliveries).toBe(3);
  expect(polls).toBe(2);
}, 30_000);

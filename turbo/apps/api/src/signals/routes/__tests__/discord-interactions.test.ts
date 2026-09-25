import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";

import { discordInteractionsContract } from "@okouai/api-contracts/contracts/discord-interactions";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  clearMockMonotonicNow,
  mockMonotonicNow,
  now,
} from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { discordInteractionsRoutes } from "../discord-interactions";

const context = testContext();
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const applicationId = "1464000000000000001";
const senderId = "1464000000000000002";
const channelId = "1464000000000000003";

const privateMessageSchema = z.object({
  content: z.string(),
  components: z.array(
    z.object({
      type: z.literal(1),
      components: z.array(
        z.object({
          type: z.number(),
          custom_id: z.string(),
          label: z.string().optional(),
          options: z
            .array(z.object({ label: z.string(), value: z.string() }))
            .optional(),
        }),
      ),
    }),
  ),
  allowed_mentions: z.object({ parse: z.array(z.string()) }),
});

function command(name: string) {
  return {
    id: String(
      1_000_000_000_000_000_000n +
        BigInt(`0x${randomBytes(7).toString("hex")}`),
    ),
    application_id: applicationId,
    token: randomUUID(),
    type: 2,
    version: 1,
    channel_id: channelId,
    user: { id: senderId },
    data: {
      id: "1464000000000000005",
      type: 1,
      name: "okou",
      options: [{ type: 1, name }],
    },
  };
}

function signedRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now() / 1000));
  const signature = sign(
    null,
    Buffer.from(`${timestamp}${body}`),
    keys.privateKey,
  ).toString("hex");
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": signature,
    },
  };
}

function client() {
  return setupApp({ context, routes: discordInteractionsRoutes })(
    discordInteractionsContract,
  );
}

function privateResponses() {
  const acknowledged = new Set<string>();
  const callbacks: unknown[] = [];
  const messages: z.infer<typeof privateMessageSchema>[] = [];
  const delivered = createDeferredPromise<z.infer<typeof privateMessageSchema>>(
    context.signal,
  );
  server.use(
    http.post(
      "https://discord.com/api/v10/interactions/:id/:token/callback",
      async ({ request, params }) => {
        callbacks.push(await request.json());
        const id = String(params.id);
        if (acknowledged.has(id)) {
          return HttpResponse.json(
            {
              code: 40_060,
              message: "Interaction has already been acknowledged.",
            },
            { status: 400 },
          );
        }
        acknowledged.add(id);
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.patch(
      "https://discord.com/api/v10/webhooks/:applicationId/:token/messages/@original",
      async ({ request }) => {
        const message = privateMessageSchema.parse(await request.json());
        messages.push(message);
        delivered.resolve(message);
        return HttpResponse.json({
          id: "1464000000000000004",
          channel_id: channelId,
          author: { id: applicationId, username: "okou", bot: true },
          content: message.content,
          timestamp: new Date(now()).toISOString(),
          attachments: [],
        });
      },
    ),
  );
  return { delivered: delivered.promise, messages, callbacks };
}

beforeEach(() => {
  mockEnv("DISCORD_PUBLIC_KEY", publicKey);
  mockEnv("DISCORD_APPLICATION_ID", applicationId);
  mockEnv("DISCORD_BOT_TOKEN", randomBytes(32).toString("hex"));
  mockEnv("DISCORD_GATEWAY_SECRET", randomBytes(32).toString("hex"));
});

describe("Discord private account interactions", () => {
  it("acknowledges once, replies privately, and rejects a replay before side effects", async () => {
    const replies = privateResponses();
    const request = signedRequest(command("help"));
    await accept(client().post(request), [202]);
    expect((await replies.delivered).content).toContain("/okou disconnect");
    await accept(client().post(request), [202]);
    expect(replies.messages).toHaveLength(1);
    expect(replies.callbacks[0]).toStrictEqual({
      type: 5,
      data: { flags: 64 },
    });
    expect(replies.messages[0]?.allowed_mentions.parse).toStrictEqual([]);
  });

  it("gives an unbound sender honest setup guidance without pretending to connect", async () => {
    const replies = privateResponses();
    await accept(client().post(signedRequest(command("connect"))), [202]);
    const message = await replies.delivered;
    expect(message.content).toContain("onboarding is not available yet");
    expect(message.content).toContain("does not connect or verify an account");
    expect(message.components).toStrictEqual([]);
  });

  it("rejects a forged picker without reading or changing another account", async () => {
    const replies = privateResponses();
    const payload = {
      ...command("switch"),
      type: 3,
      data: {
        component_type: 3,
        custom_id: `okou:1:agent:${randomUUID()}:0:ffff:forged`,
        values: [randomUUID()],
      },
    };
    await accept(client().post(signedRequest(payload)), [202]);
    const message = await replies.delivered;
    expect(message.content).toContain("expired or your access has changed");
    // A deferred update edits the picker message rather than adding a reply.
    expect(replies.callbacks).toStrictEqual([{ type: 6 }]);
    expect(message.components).toStrictEqual([]);
  });

  it("does not execute work after a rejected callback acknowledgement", async () => {
    server.use(
      http.post(
        "https://discord.com/api/v10/interactions/:id/:token/callback",
        () => {
          return HttpResponse.json(
            { code: 10_062, message: "Unknown interaction" },
            { status: 404 },
          );
        },
      ),
    );
    const result = await accept(
      client().post(signedRequest(command("disconnect"))),
      [503],
    );
    expect(result.body.error).toBe(
      "Discord could not acknowledge the interaction",
    );
  });

  it.each([
    {
      kind: "timed-out",
      response: async (request: Request) => {
        // Discord answers only after the 2 s local deadline aborted the request.
        const aborted = createDeferredPromise<void>(context.signal);
        request.signal.addEventListener("abort", () => {
          aborted.resolve();
        });
        await aborted.promise;
        return new HttpResponse(null, { status: 204 });
      },
    },
    {
      kind: "network failure",
      response: () => {
        return HttpResponse.error();
      },
    },
    {
      kind: "Discord server error",
      response: () => {
        return HttpResponse.json({ message: "Unavailable" }, { status: 503 });
      },
    },
  ])(
    "reports no change instead of failing after a $kind acknowledgement",
    async ({ response }) => {
      const replies = privateResponses();
      mockMonotonicNow(0);
      onTestFinished(clearMockMonotonicNow);
      server.use(
        http.post(
          "https://discord.com/api/v10/interactions/:id/:token/callback",
          async ({ request }) => {
            // Let Discord's 3-second response window close before the edit.
            mockMonotonicNow(10_000);
            return await response(request);
          },
        ),
      );

      const result = await client().post(signedRequest(command("help")));

      expect(result.status).toBe(202);
      const message = await replies.delivered;
      expect(message.content).toContain("no changes were made");
      expect(message.content).not.toContain("/okou disconnect");
      expect(message.components).toStrictEqual([]);
      expect(replies.messages).toHaveLength(1);
    },
  );

  it("accepts Discord rejecting the no-change edit when the acknowledgement never arrived", async () => {
    const attempted = createDeferredPromise<void>(context.signal);
    mockMonotonicNow(0);
    onTestFinished(clearMockMonotonicNow);
    server.use(
      http.post(
        "https://discord.com/api/v10/interactions/:id/:token/callback",
        () => {
          mockMonotonicNow(10_000);
          return HttpResponse.error();
        },
      ),
      http.patch(
        "https://discord.com/api/v10/webhooks/:applicationId/:token/messages/@original",
        () => {
          attempted.resolve();
          return HttpResponse.json(
            { code: 10_015, message: "Unknown Webhook" },
            { status: 404 },
          );
        },
      ),
    );

    const result = await client().post(signedRequest(command("disconnect")));

    expect(result.status).toBe(202);
    await attempted.promise;
  });
});

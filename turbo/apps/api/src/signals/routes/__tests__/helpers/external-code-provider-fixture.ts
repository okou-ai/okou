import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { MsgPack } from "ably/modular";
import { http, HttpResponse } from "msw";
import { Webhook } from "svix";
import { expect, vi } from "vitest";
import { z } from "zod";

import type { TestContext } from "../../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv, optionalEnv } from "../../../../lib/env";
import { nowDate } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { settleIncludingAbort } from "../../../utils";
import type { ApiTestUser } from "./api-bdd";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

const ablyKey = "externalcode.key:external-code-synthetic-secret";
const signingSecret = `whsec_${Buffer.from("external-code-workspace-fixture").toString("base64")}`;
const connectorChanged = Object.freeze({
  name: "connector:changed",
  data: JSON.stringify({ connectorSlug: "aws" }),
  encoding: "json",
});
const wireMessages = z.array(
  z.object({
    name: z.literal(connectorChanged.name),
    data: z.literal(connectorChanged.data),
    encoding: z.literal(connectorChanged.encoding),
  }),
);

function decodeMessages(body: ArrayBuffer): unknown {
  if (
    typeof MsgPack !== "object" ||
    MsgPack === null ||
    !("decode" in MsgPack) ||
    typeof MsgPack.decode !== "function"
  ) {
    throw new Error("Expected the Ably MessagePack codec");
  }
  return MsgPack.decode(body);
}

/** Exercise native SDK transports through the centralized provider registry. */
export function createExternalCodeProviderFixture(
  context: TestContext,
  actor: ApiTestUser,
) {
  const channel = `user:${actor.userId}`;
  const publications: unknown[] = [];
  const invalidRequests: unknown[] = [];

  async function readPublication(request: Request, channelName: unknown) {
    const messages = wireMessages.parse(
      decodeMessages(await request.arrayBuffer()),
    );
    if (
      channelName !== channel ||
      request.headers.get("authorization") !==
        `Basic ${Buffer.from(ablyKey).toString("base64")}` ||
      !request.headers.get("content-type")?.startsWith("application/x-msgpack")
    ) {
      throw new Error("Invalid Ably publication channel or authentication");
    }
    return messages.map((message) => {
      return { channel: channelName, ...message };
    });
  }

  const publishHandler = http.post(
    "https://main.realtime.ably.net/channels/:channelName/messages",
    async ({ request, params }) => {
      const received = await settleIncludingAbort(
        readPublication(request, params.channelName),
      );
      if (!received.ok) {
        invalidRequests.push(received.error);
        return HttpResponse.json(
          {
            error: {
              code: 40_000,
              statusCode: 400,
              message: "Invalid publication",
            },
          },
          { status: 400 },
        );
      }
      publications.push(...received.value);
      return HttpResponse.json({ serials: [null] }, { status: 201 });
    },
  );

  mockEnv("ABLY_API_KEY", ablyKey);
  context.mocks.ably.useRealPublish.mockReturnValue(true);
  server.use(publishHandler);

  return {
    async expectConnectorChanged(): Promise<void> {
      await flushWaitUntilForTest();
      expect(invalidRequests).toStrictEqual([]);
      expect(publications.splice(0)).toContainEqual({
        channel,
        ...connectorChanged,
      });
    },

    async deleteWorkspace(): Promise<void> {
      if (!actor.orgId) {
        throw new Error("Expected an owned workspace to clean up");
      }
      const sdk = await vi.importActual<
        typeof import("@clerk/backend/webhooks")
      >("@clerk/backend/webhooks");
      const body = JSON.stringify({
        type: "organization.deleted",
        data: { id: actor.orgId },
      });
      const id = randomUUID();
      const at = nowDate();
      const headers = {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
        "svix-signature": new Webhook(signingSecret).sign(id, at, body),
      };
      const previousSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
      const previousPublishMode = context.mocks.ably.useRealPublish();
      const previousVerifier =
        context.mocks.clerk.verifyWebhook.getMockImplementation();
      mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", signingSecret);
      context.mocks.clerk.verifyWebhook.mockImplementation(
        (request: unknown, options: unknown) => {
          if (!(request instanceof Request)) {
            throw new Error("Expected a Clerk webhook request");
          }
          return sdk.verifyWebhook(
            request,
            z.object({ signingSecret: z.string() }).parse(options),
          );
        },
      );
      // Shared afterEach resets providers before the owner's finished callback.
      context.mocks.ably.useRealPublish.mockReturnValue(true);
      server.use(publishHandler);
      const deleted = await settleIncludingAbort(
        createWebhookCallbackApi(context).requestClerkWebhook(
          body,
          headers,
          [200],
        ),
      );
      await flushWaitUntilForTest().finally(() => {
        mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousSecret);
        if (previousVerifier) {
          context.mocks.clerk.verifyWebhook.mockImplementation(
            previousVerifier,
          );
        } else {
          context.mocks.clerk.verifyWebhook.mockReset();
        }
        context.mocks.ably.useRealPublish.mockReturnValue(previousPublishMode);
        server.resetHandlers(
          ...server.listHandlers().filter((handler) => {
            return handler !== publishHandler;
          }),
        );
      });
      if (!deleted.ok) {
        throw deleted.error;
      }
    },
  };
}

import { Buffer } from "node:buffer";
import { MsgPack } from "ably/modular";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";
import * as z from "zod";

import type { TestContext } from "../../../../__tests__/test-context";
import { env, mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { settleIncludingAbort } from "../../../utils";
import type { ApiTestUser } from "./api-bdd";

const ablyKey = "externalcode.key:external-code-synthetic-secret";
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

  const previousAblyKey = env("ABLY_API_KEY");
  const previousPublishMode = context.mocks.ably.useRealPublish();
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

    async restore(): Promise<void> {
      await flushWaitUntilForTest().finally(() => {
        mockEnv("ABLY_API_KEY", previousAblyKey);
        context.mocks.ably.useRealPublish.mockReturnValue(previousPublishMode);
        server.resetHandlers(
          ...server.listHandlers().filter((handler) => {
            return handler !== publishHandler;
          }),
        );
      });
      expect(invalidRequests).toStrictEqual([]);
    },
  };
}

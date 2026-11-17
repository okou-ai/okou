import { MsgPack } from "ably/modular";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";
import type { TestContext } from "../../../../__tests__/test-context";
import { mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";

export function captureRewardProjectionPublications(
  context: TestContext,
  rejectFirst = false,
) {
  mockEnv("ABLY_API_KEY", "projection.key:projection-provider-secret");
  context.mocks.ably.useRealPublish.mockReturnValue(true);
  const publications: { channel: string; name: string }[] = [];
  let reject = rejectFirst;
  server.use(
    http.post(
      "https://main.realtime.ably.net/channels/:channelName/messages",
      async ({ request, params }) => {
        if (
          typeof MsgPack !== "object" ||
          MsgPack === null ||
          !("decode" in MsgPack) ||
          typeof MsgPack.decode !== "function"
        ) {
          throw new Error("Expected native Ably MessagePack codec");
        }
        const messages = array(object({ name: string() })).parse(
          MsgPack.decode(await request.arrayBuffer()),
        );
        if (reject) {
          reject = false;
          return HttpResponse.json(
            {
              error: {
                statusCode: 400,
                code: 40_000,
                message: "Publish not accepted",
              },
            },
            { status: 400 },
          );
        }
        for (const message of messages) {
          publications.push({
            channel: String(params.channelName),
            name: message.name,
          });
        }
        if (!("encode" in MsgPack) || typeof MsgPack.encode !== "function") {
          throw new Error("Expected native Ably MessagePack encoder");
        }
        const encoded: unknown = MsgPack.encode({ serials: [null] });
        if (!(encoded instanceof ArrayBuffer)) {
          throw new Error("Expected a MessagePack response buffer");
        }
        return HttpResponse.arrayBuffer(encoded, {
          status: 201,
          headers: { "content-type": "application/x-msgpack" },
        });
      },
    ),
  );
  return publications;
}

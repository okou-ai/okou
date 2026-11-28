import { randomUUID } from "node:crypto";
import {
  getWechatUpdates,
  sendWechatText,
  WECHAT_ORIGIN,
  WechatSessionExpiredError,
} from "@okouai/core/wechat-client";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";

const context = testContext();

test("wechat-client-001 keeps a uint64 message ID whole and the message text unchanged", async () => {
  const token = `wechat-session-${randomUUID()}`;
  server.use(
    http.post(`${WECHAT_ORIGIN}/ilink/bot/getupdates`, ({ request }) => {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return HttpResponse.json({ ret: -14 });
      }
      // Raw provider bytes: the numeric ID exceeds Number.MAX_SAFE_INTEGER.
      return new HttpResponse(
        '{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":18446744073709551615,"from_user_id":"user@im.wechat","message_type":1,"item_list":[{"type":1,"text_item":{"text":"message_id: 123"}}]}]}',
        { headers: { "content-type": "application/json" } },
      );
    }),
  );

  const updates = await getWechatUpdates(
    WECHAT_ORIGIN,
    token,
    "",
    context.signal,
  );

  expect(updates?.msgs).toStrictEqual([
    expect.objectContaining({
      message_id: "18446744073709551615",
      item_list: [{ type: 1, text_item: { text: "message_id: 123" } }],
    }),
  ]);
});

test("wechat-client-002 rejects a send that WeChat refuses with HTTP 200", async () => {
  server.use(
    http.post(`${WECHAT_ORIGIN}/ilink/bot/sendmessage`, () => {
      return HttpResponse.json({ ret: -1, errmsg: "private provider detail" });
    }),
  );

  const sent = sendWechatText(
    {
      baseUrl: WECHAT_ORIGIN,
      token: `wechat-session-${randomUUID()}`,
      senderId: "recipient@im.wechat",
      contextToken: `context-${randomUUID()}`,
      clientId: randomUUID(),
      text: "Hello",
    },
    context.signal,
  );

  await expect(sent).rejects.toThrow("WeChat rejected the request");
});

test("wechat-client-003 reports an expired WeChat session distinctly", async () => {
  server.use(
    http.post(`${WECHAT_ORIGIN}/ilink/bot/getupdates`, () => {
      return HttpResponse.json({ ret: -14 });
    }),
  );

  const polled = getWechatUpdates(
    WECHAT_ORIGIN,
    `wechat-session-${randomUUID()}`,
    "",
    context.signal,
  );

  await expect(polled).rejects.toBeInstanceOf(WechatSessionExpiredError);
});

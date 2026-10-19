import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import {
  getWechatUpdates,
  sendWechatText,
  wechatOrigin,
  WechatSessionExpiredError,
} from "@okouai/core/wechat-client";
const origin = "https://ilinkai.weixin.qq.com";
describe("WeChat protocol boundaries", () => {
  it("preserves uint64 IDs and does not rewrite message text", async () => {
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return new HttpResponse(
          '{"ret":0,"msgs":[{"message_id":18446744073709551615,"message_type":1,"from_user_id":"scanner","item_list":[{"type":1,"text_item":{"text":"message_id: 123"}}]}],"get_updates_buf":"cursor"}',
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const result = await getWechatUpdates(
      origin,
      "test-token",
      "",
      new AbortController().signal,
    );
    expect(result?.msgs?.[0]?.message_id).toBe("18446744073709551615");
    expect(result?.msgs?.[0]?.item_list?.[0]?.text_item?.text).toBe(
      "message_id: 123",
    );
  });
  it("recognizes a provider business failure even with HTTP 200", async () => {
    server.use(
      http.post(`${origin}/ilink/bot/sendmessage`, () => {
        return HttpResponse.json({
          ret: -1,
          errmsg: "private provider detail",
        });
      }),
    );
    await expect(
      sendWechatText(
        {
          baseUrl: origin,
          token: "test-token",
          senderId: "scanner",
          contextToken: "private-context",
          clientId: "test-id",
          text: "hello",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("WeChat rejected the request");
  });
  it("marks expired sessions distinctly", async () => {
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return HttpResponse.json({ ret: -14 });
      }),
    );
    await expect(
      getWechatUpdates(origin, "test-token", "", new AbortController().signal),
    ).rejects.toBeInstanceOf(WechatSessionExpiredError);
  });
  it("rejects provider redirects without forwarding credentials", async () => {
    server.use(
      http.post(`${origin}/ilink/bot/getupdates`, () => {
        return new HttpResponse(null, {
          status: 307,
          headers: { Location: "https://other-provider.test/getupdates" },
        });
      }),
      http.post("https://other-provider.test/getupdates", () => {
        return HttpResponse.json({ msgs: [] });
      }),
    );
    await expect(
      getWechatUpdates(origin, "test-token", "", new AbortController().signal),
    ).rejects.toThrow("WeChat request failed (307)");
  });
  it.each([
    "http://ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com.evil.test",
    "https://evil.test",
    "https://user:secret@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com:444",
    "https://ilinkai.weixin.qq.com/path",
  ])(
    "rejects a credential destination outside the trusted origin: %s",
    (value) => {
      expect(() => {
        return wechatOrigin(value);
      }).toThrow("Invalid WeChat service origin");
    },
  );
});

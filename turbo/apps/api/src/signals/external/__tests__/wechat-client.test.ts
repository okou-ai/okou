import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-context";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import {
  getWechatUpdates,
  sendWechatText,
  wechatOrigin,
  WechatSessionExpiredError,
} from "@okouai/core/wechat-client";
const origin = "https://ilinkai.weixin.qq.com";
const context = testContext();
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
  it.each([
    [
      "transport failure",
      () => {
        return HttpResponse.error();
      },
      "Failed to fetch",
    ],
    [
      "upstream timeout response",
      () => {
        return new HttpResponse(null, { status: 504 });
      },
      "WeChat request failed (504)",
    ],
    [
      "provider rejection",
      () => {
        return HttpResponse.json({ ret: -1 });
      },
      "WeChat rejected the request",
    ],
  ] as const)(
    "keeps a %s visible to the receiver",
    async (_name, response, error) => {
      server.use(http.post(`${origin}/ilink/bot/getupdates`, response));
      await expect(
        getWechatUpdates(origin, "test-token", "saved-cursor", context.signal),
      ).rejects.toThrow(error);
    },
  );
  it.each(["AbortError", "TimeoutError"])(
    "propagates a caller-owned %s instead of reporting an idle receive",
    async (name) => {
      const entered = createDeferredPromise<void>(context.signal);
      const aborted = createDeferredPromise<void>(context.signal);
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      server.use(
        http.post(`${origin}/ilink/bot/getupdates`, async ({ request }) => {
          const resolve = () => {
            if (!aborted.settled()) {
              aborted.resolve();
            }
          };
          if (request.signal.aborted) {
            resolve();
          } else {
            request.signal.addEventListener("abort", resolve, { once: true });
          }
          entered.resolve();
          await aborted.promise;
          return HttpResponse.json({ msgs: [] });
        }),
      );
      const reason = new DOMException("Receiver stopped", name);
      const pending = settleIncludingAbort(
        getWechatUpdates(origin, "test-token", "saved-cursor", signal),
      );
      await entered.promise;
      controller.abort(reason);
      await expect(pending).resolves.toStrictEqual({
        ok: false,
        error: reason,
      });
    },
  );
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

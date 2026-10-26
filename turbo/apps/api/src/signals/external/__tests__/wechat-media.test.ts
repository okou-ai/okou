import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { array, number, object, string } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import {
  downloadWechatMedia,
  uploadWechatMedia,
  sendWechatMedia,
} from "../wechat-media";
const context = testContext();
const origin = "https://ilinkai.weixin.qq.com";
const cdn = "https://novac2c.cdn.weixin.qq.com/c2c";
const bytes = Buffer.from("a,b\n1,2\n");
function encrypted(key: Buffer) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
describe("WeChat media wire boundary", () => {
  it.each(["raw", "hex"])(
    "decrypts the provider's %s key encoding without exposing credentials to the CDN",
    async (encoding) => {
      const key = randomBytes(16);
      const aesKey = (
        encoding === "raw" ? key : Buffer.from(key.toString("hex"))
      ).toString("base64");
      server.use(
        http.get(`${cdn}/download`, ({ request }) => {
          expect(request.headers.has("authorization")).toBeFalsy();
          expect(
            new URL(request.url).searchParams.get("encrypted_query_param"),
          ).toBe("private-query");
          return new HttpResponse(new Uint8Array(encrypted(key)));
        }),
      );
      const actual = await downloadWechatMedia(
        {
          type: 4,
          file_item: {
            len: String(bytes.length),
            media: { encrypt_query_param: "private-query", aes_key: aesKey },
          },
        },
        context.signal,
      );
      expect(Buffer.from(actual)).toStrictEqual(bytes);
    },
  );
  it.each([
    "http://novac2c.cdn.weixin.qq.com/c2c/download",
    "https://attacker.example/c2c/download",
    "https://user:pass@novac2c.cdn.weixin.qq.com/c2c/download",
    "https://novac2c.cdn.weixin.qq.com/private",
  ])("rejects an untrusted media target %s", async (fullUrl) => {
    await expect(
      downloadWechatMedia(
        {
          type: 4,
          file_item: {
            media: {
              full_url: fullUrl,
              aes_key: randomBytes(16).toString("base64"),
            },
          },
        },
        context.signal,
      ),
    ).rejects.toThrow("invalid media origin");
  });
  it("reads the upstream plain-image variant without inventing a key", async () => {
    server.use(
      http.get(`${cdn}/download`, () => {
        return new HttpResponse(new Uint8Array(bytes));
      }),
    );
    expect(
      Buffer.from(
        await downloadWechatMedia(
          {
            type: 2,
            image_item: { media: { encrypt_query_param: "plain-image" } },
          },
          context.signal,
        ),
      ),
    ).toStrictEqual(bytes);
  });
  it("rejects size mismatches after decryption", async () => {
    const key = randomBytes(16);
    server.use(
      http.get(`${cdn}/download`, () => {
        return new HttpResponse(new Uint8Array(encrypted(key)));
      }),
    );
    await expect(
      downloadWechatMedia(
        {
          type: 4,
          file_item: {
            len: "100",
            media: {
              encrypt_query_param: "query",
              aes_key: key.toString("base64"),
            },
          },
        },
        context.signal,
      ),
    ).rejects.toThrow("size does not match");
  });
  it("bounds encrypted download bytes", async () => {
    server.use(
      http.get(`${cdn}/download`, () => {
        return new HttpResponse(new Uint8Array(10 * 1024 * 1024 + 32));
      }),
    );
    await expect(
      downloadWechatMedia(
        {
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: "query",
              aes_key: randomBytes(16).toString("base64"),
            },
          },
        },
        context.signal,
      ),
    ).rejects.toThrow("exceeds 10 MiB");
  });
  it.each([
    { contentType: "text/csv", mediaType: 3, itemType: 4 },
    { contentType: "image/png", mediaType: 1, itemType: 2 },
    { contentType: "video/mp4", mediaType: 2, itemType: 5 },
  ])(
    "uploads and sends $contentType with exact provider message IDs",
    async ({ contentType, mediaType, itemType }) => {
      let key: Buffer | undefined;
      server.use(
        http.post(`${origin}/ilink/bot/getuploadurl`, async ({ request }) => {
          const body = object({
            aeskey: string(),
            rawsize: number(),
            filesize: number(),
            media_type: number(),
          }).parse(await request.json());
          expect(body).toMatchObject({
            rawsize: bytes.length,
            filesize: 16,
            media_type: mediaType,
          });
          key = Buffer.from(body.aeskey, "hex");
          return HttpResponse.json({ ret: 0, upload_param: "upload-query" });
        }),
        http.post(`${cdn}/upload`, async ({ request }) => {
          expect(request.headers.has("authorization")).toBeFalsy();
          if (!key) {
            throw new Error("Expected upload encryption key");
          }
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          expect(
            Buffer.concat([
              decipher.update(Buffer.from(await request.arrayBuffer())),
              decipher.final(),
            ]),
          ).toStrictEqual(bytes);
          return new HttpResponse(null, {
            headers: { "x-encrypted-param": "download-query" },
          });
        }),
        http.post(`${origin}/ilink/bot/sendmessage`, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer provider-test-token",
          );
          const body = object({
            msg: object({
              context_token: string(),
              item_list: array(object({ type: number() })),
            }),
          }).parse(await request.json());
          expect(body.msg.context_token).toBe("private-context");
          expect(body.msg.item_list).toStrictEqual([{ type: itemType }]);
          return new HttpResponse(
            '{"ret":0,"message_id":18446744073709551615}',
            { headers: { "Content-Type": "application/json" } },
          );
        }),
      );
      const access = {
        baseUrl: origin,
        token: "provider-test-token",
        senderId: "sender",
      };
      const item = await uploadWechatMedia(
        { ...access, bytes, filename: "file", contentType },
        context.signal,
      );
      expect(
        (
          await sendWechatMedia(
            {
              ...access,
              item,
              contextToken: "private-context",
              clientId: "client",
            },
            context.signal,
          )
        ).message_id,
      ).toBe("18446744073709551615");
    },
  );
});

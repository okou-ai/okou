import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { WECHAT_ORIGIN } from "@okouai/core/wechat-client";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import {
  downloadWechatMedia,
  sendWechatMedia,
  uploadWechatMedia,
} from "../wechat-media";

const context = testContext();
const CDN_ORIGIN = "https://novac2c.cdn.weixin.qq.com";

interface CdnRequest {
  readonly url: URL;
  readonly authorization: string | null;
  readonly body: Buffer;
}

function encrypt(key: Buffer, bytes: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

function decrypt(key: Buffer, bytes: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
}

/** The CDN serves one object for its download query token. */
function serveCdnDownload(query: string, body: Buffer): CdnRequest[] {
  const requests: CdnRequest[] = [];
  server.use(
    http.get(`${CDN_ORIGIN}/c2c/download`, ({ request }) => {
      const url = new URL(request.url);
      requests.push({
        url,
        authorization: request.headers.get("authorization"),
        body: Buffer.alloc(0),
      });
      if (url.searchParams.get("encrypted_query_param") !== query) {
        return new HttpResponse(null, { status: 404 });
      }
      return new HttpResponse(new Uint8Array(body), {
        headers: { "content-type": "application/octet-stream" },
      });
    }),
  );
  return requests;
}

/** WeChat's upload URL, CDN upload and message send for one media item. */
function serveMediaDelivery() {
  const uploadRequests: Record<string, unknown>[] = [];
  const cdnRequests: CdnRequest[] = [];
  const sendRequests: { authorization: string | null; body: unknown }[] = [];
  const uploadParam = `upload-${randomUUID()}`;
  server.use(
    http.post(
      `${WECHAT_ORIGIN}/ilink/bot/getuploadurl`,
      async ({ request }) => {
        const body: unknown = await request.json();
        if (typeof body !== "object" || body === null) {
          throw new Error("Expected a JSON upload URL request");
        }
        uploadRequests.push({ ...body });
        return HttpResponse.json({ ret: 0, upload_param: uploadParam });
      },
    ),
    http.post(`${CDN_ORIGIN}/c2c/upload`, async ({ request }) => {
      cdnRequests.push({
        url: new URL(request.url),
        authorization: request.headers.get("authorization"),
        body: Buffer.from(await request.arrayBuffer()),
      });
      return new HttpResponse(null, {
        headers: { "x-encrypted-param": `download-${randomUUID()}` },
      });
    }),
    http.post(`${WECHAT_ORIGIN}/ilink/bot/sendmessage`, async ({ request }) => {
      sendRequests.push({
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      // Raw provider bytes: the receipt ID exceeds Number.MAX_SAFE_INTEGER.
      return new HttpResponse('{"ret":0,"message_id":18446744073709551615}', {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { uploadRequests, cdnRequests, sendRequests, uploadParam };
}

async function deliverMedia(contentType: string, bytes: Buffer) {
  const provider = serveMediaDelivery();
  const token = `wechat-session-${randomUUID()}`;
  const contextToken = `context-${randomUUID()}`;
  const senderId = "recipient@im.wechat";
  const item = await uploadWechatMedia(
    {
      baseUrl: WECHAT_ORIGIN,
      token,
      senderId,
      filename: "report",
      contentType,
      bytes,
    },
    context.signal,
  );
  const receipt = await sendWechatMedia(
    {
      baseUrl: WECHAT_ORIGIN,
      token,
      senderId,
      contextToken,
      clientId: randomUUID(),
      item,
    },
    context.signal,
  );
  return { ...provider, token, contextToken, receipt };
}

/** What WeChat and its CDN observed, in the shape the Then clauses describe. */
function observedDelivery(delivery: Awaited<ReturnType<typeof deliverMedia>>) {
  const [upload] = delivery.uploadRequests;
  const [cdn] = delivery.cdnRequests;
  const aeskey = upload?.aeskey;
  if (!upload || !cdn || typeof aeskey !== "string") {
    throw new Error("Expected one upload URL request and one CDN upload");
  }
  return {
    uploads: delivery.uploadRequests.length,
    upload: {
      rawsize: upload.rawsize,
      filesize: upload.filesize,
      media_type: upload.media_type,
    },
    cdnUploads: delivery.cdnRequests.length,
    cdnAuthorization: cdn.authorization,
    cdnQuery: cdn.url.searchParams.get("encrypted_query_param"),
    cdnPlaintext: decrypt(Buffer.from(aeskey, "hex"), cdn.body),
    sends: delivery.sendRequests,
    messageId: delivery.receipt.message_id,
  };
}

function expectedDelivery(
  delivery: Awaited<ReturnType<typeof deliverMedia>>,
  bytes: Buffer,
  expected: { readonly mediaType: number; readonly itemType: number },
) {
  return {
    uploads: 1,
    upload: {
      rawsize: bytes.length,
      filesize: 16,
      media_type: expected.mediaType,
    },
    cdnUploads: 1,
    cdnAuthorization: null,
    cdnQuery: delivery.uploadParam,
    cdnPlaintext: bytes,
    sends: [
      {
        authorization: `Bearer ${delivery.token}`,
        body: expect.objectContaining({
          msg: expect.objectContaining({
            context_token: delivery.contextToken,
            item_list: [expect.objectContaining({ type: expected.itemType })],
          }),
        }),
      },
    ],
    messageId: "18446744073709551615",
  };
}

test("wechat-media-001 decrypts a raw base64 key file without sending credentials to the CDN", async () => {
  const csv = Buffer.from("name,amount\nalice,42\nbob,7\n");
  const key = randomBytes(16);
  const query = `download-${randomUUID()}`;
  const requests = serveCdnDownload(query, encrypt(key, csv));

  const bytes = await downloadWechatMedia(
    {
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: query,
          aes_key: key.toString("base64"),
          encrypt_type: 1,
        },
        file_name: "report.csv",
        len: String(csv.length),
      },
    },
    context.signal,
  );

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url.searchParams.get("encrypted_query_param")).toBe(
    query,
  );
  expect(requests[0]?.authorization).toBeNull();
  expect(Buffer.from(bytes).equals(csv)).toBeTruthy();
});

test("wechat-media-007 returns a plain image body when the descriptor has no key", async () => {
  const image = randomBytes(64);
  const query = `download-${randomUUID()}`;
  serveCdnDownload(query, image);

  const bytes = await downloadWechatMedia(
    { type: 2, image_item: { media: { encrypt_query_param: query } } },
    context.signal,
  );

  expect(Buffer.from(bytes).equals(image)).toBeTruthy();
});

test("wechat-media-010 uploads and sends a text/csv file with the exact provider message ID", async () => {
  const csv = Buffer.from("a,b\n1,2\n");

  const delivery = await deliverMedia("text/csv", csv);

  expect(observedDelivery(delivery)).toStrictEqual(
    expectedDelivery(delivery, csv, { mediaType: 3, itemType: 4 }),
  );
});

test("wechat-media-011 uploads and sends an image/png with the exact provider message ID", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const delivery = await deliverMedia("image/png", png);

  expect(observedDelivery(delivery)).toStrictEqual(
    expectedDelivery(delivery, png, { mediaType: 1, itemType: 2 }),
  );
});

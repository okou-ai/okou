import { PutObjectCommand } from "@aws-sdk/client-s3";
import { http, HttpResponse } from "msw";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "../../../../__tests__/test-context";
import { server } from "../../../../mocks/server";
import type { createChatCallbacksApi } from "./api-bdd-chat-callbacks";

import type {
  HostedSitePrepareRequest,
  HostedSitePrepareResponse,
} from "@okouai/api-contracts/contracts/host";

export function hostedTextFile(
  path: string,
  content: string,
  contentType = "text/html; charset=utf-8",
): HostedSitePrepareRequest["files"][number] {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}

/** Model presigned upload transport; objects exist only after the caller PUTs. */
export function installHostedUploadTransport(
  context: TestContext,
  storage: Pick<
    ReturnType<
      ReturnType<typeof createChatCallbacksApi>["acceptChatObjectStorage"]
    >,
    "addObject"
  >,
) {
  const uploads = new Map<string, PutObjectCommand["input"]>();
  const previous = context.mocks.s3.getSignedUrl.getMockImplementation();
  context.mocks.s3.getSignedUrl.mockImplementation(
    (client, command, options) => {
      if (!(command instanceof PutObjectCommand)) {
        if (!previous) {
          throw new Error("Expected a storage download transport");
        }
        return previous(client, command, options);
      }
      const url = `https://hosted-upload.example/${randomUUID()}`;
      uploads.set(url, command.input);
      return Promise.resolve(url);
    },
  );
  server.use(
    http.put("https://hosted-upload.example/*", async ({ request }) => {
      const input = uploads.get(request.url);
      if (!input?.Bucket || !input.Key) {
        return new HttpResponse(null, { status: 403 });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      storage.addObject({
        bucket: input.Bucket,
        key: input.Key,
        size: body.byteLength,
        body,
        ...(input.ContentType === undefined
          ? {}
          : { contentType: input.ContentType }),
        ...(input.Metadata === undefined ? {} : { metadata: input.Metadata }),
      });
      return new HttpResponse(null, { status: 200 });
    }),
  );
}

export async function uploadHostedTextFiles(
  prepared: Pick<HostedSitePrepareResponse, "uploads">,
  files: Readonly<Record<string, string>>,
) {
  for (const upload of prepared.uploads) {
    const body = files[upload.path];
    if (body === undefined) {
      throw new Error(`Missing upload content for ${upload.path}`);
    }
    const response = await fetch(upload.uploadUrl, { method: "PUT", body });
    if (response.status !== 200) {
      throw new Error(`Hosted upload failed: ${response.status}`);
    }
  }
}

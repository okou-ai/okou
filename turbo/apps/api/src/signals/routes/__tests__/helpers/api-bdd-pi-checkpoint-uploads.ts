import { PutObjectCommand } from "@aws-sdk/client-s3";
import { http, HttpResponse } from "msw";
import type { TestContext } from "../../../../__tests__/test-context";
import { server } from "../../../../mocks/server";

export function mockPiCheckpointUploads(
  context: TestContext,
  objects: Map<string, Buffer>,
): void {
  const uploadObjects = new Map<string, string>();
  const presign = context.mocks.s3.getSignedUrl.getMockImplementation();
  if (!presign) {
    throw new Error("Expected the test object presigner");
  }
  context.mocks.s3.getSignedUrl.mockImplementation(
    (client, command, options) => {
      if (!(command instanceof PutObjectCommand)) {
        return presign(client, command, options);
      }
      const bucket = command.input.Bucket;
      const key = command.input.Key;
      if (!bucket || !key) {
        throw new Error("Expected a checkpoint upload object identity");
      }
      const url = new URL("https://r2.example.com/upload");
      url.searchParams.set("sig", "bdd");
      const objectKey = `${bucket}/${key}`;
      url.searchParams.set("object", objectKey);
      const uploadUrl = url.toString();
      uploadObjects.set(uploadUrl, objectKey);
      return Promise.resolve(uploadUrl);
    },
  );
  server.use(
    http.put("https://r2.example.com/upload", async ({ request }) => {
      const objectKey = uploadObjects.get(request.url);
      if (!objectKey) {
        throw new Error("Expected the prepared checkpoint upload identity");
      }
      objects.set(objectKey, Buffer.from(await request.arrayBuffer()));
      return new HttpResponse(null, { status: 200 });
    }),
  );
}

import { HttpResponse, http } from "msw";
import { gunzipSync } from "node:zlib";
import { onTestFinished } from "vitest";
import { apiTestS3PresignedUrl } from "../../../../__tests__/mocks";
import type { TestContext } from "../../../../__tests__/test-context";
import { server } from "../../../../mocks/server";

/** Installs a private in-memory R2 archive for one snapshot compaction test. */
export function mockChatThreadSnapshotStorage(context: TestContext): void {
  const objects = new Map<string, Buffer>();
  const previousSend = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      return Promise.resolve(apiTestS3PresignedUrl(command));
    },
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const candidate = command as {
      readonly constructor?: { readonly name?: string };
      readonly input?: { readonly Key?: unknown; readonly Body?: unknown };
    };
    const key = candidate.input?.Key;
    if (
      typeof key === "string" &&
      key.startsWith("chat-thread-snapshots/v1/")
    ) {
      if (candidate.constructor?.name === "PutObjectCommand") {
        if (!Buffer.isBuffer(candidate.input?.Body)) {
          throw new Error("Expected compressed thread snapshot bytes");
        }
        objects.set(key, candidate.input.Body);
        return Promise.resolve({});
      }
      if (candidate.constructor?.name === "GetObjectCommand") {
        const body = objects.get(key);
        if (!body) {
          throw new Error("Thread snapshot object missing from test storage");
        }
        return Promise.resolve({
          Body: (async function* () {
            yield body;
          })(),
          ContentLength: body.length,
        });
      }
    }
    return previousSend?.(command) ?? Promise.resolve({});
  });
  server.use(
    http.get("https://r2.example.com/storage/archive.tar.gz", ({ request }) => {
      const object = new URL(request.url).searchParams.get("object");
      const marker = "/chat-thread-snapshots/v1/";
      const index = object?.indexOf(marker) ?? -1;
      if (index < 0 || object === null) {
        return undefined;
      }
      const body = objects.get(object.slice(index + 1));
      if (!body) {
        return HttpResponse.json({ error: "missing" }, { status: 404 });
      }
      return HttpResponse.json(JSON.parse(gunzipSync(body).toString("utf8")));
    }),
  );
  onTestFinished(() => {
    objects.clear();
  });
}

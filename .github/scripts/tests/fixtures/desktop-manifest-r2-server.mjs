import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

export const currentKey = "desktop-updates/okou/manifest.json";

function etag(body) {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}

export async function startS3(t, { current, mode, concurrent } = {}) {
  const objects = new Map();
  if (current) objects.set(currentKey, current);
  const requests = [];
  let sourceRead = false;
  let signalPut;
  const currentPut = new Promise((resolve) => {
    signalPut = resolve;
  });
  let signalClosed;
  const uploadClosed = new Promise((resolve) => {
    signalClosed = resolve;
  });
  const fail = (response, status, code) => {
    response.writeHead(status, { "content-type": "application/xml" });
    response.end(
      `<Error><Code>${code}</Code><Message>fixture</Message></Error>`,
    );
  };
  const server = createServer(async (request, response) => {
    const key = new URL(request.url, "http://localhost").pathname.slice(
      "/desktop-test/".length,
    );
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, key });
    if (request.method === "GET") {
      if (mode === "denied" && key === currentKey) {
        return fail(response, 403, "AccessDenied");
      }
      const object = objects.get(key);
      if (!object) return fail(response, 404, "NoSuchKey");
      response.writeHead(200, {
        etag: etag(object),
        "content-length": object.length,
        "content-type": "application/json",
      });
      if (mode === "conflict" && key === currentKey && !sourceRead) {
        sourceRead = true;
        objects.set(currentKey, concurrent);
      }
      return response.end(object);
    }
    if (request.method !== "PUT")
      return fail(response, 405, "MethodNotAllowed");
    if (key === currentKey) {
      signalPut();
      if (mode === "cancel") {
        request.socket.once("close", signalClosed);
        return;
      }
    }
    const previous = objects.get(key);
    if (
      (request.headers["if-none-match"] === "*" && previous) ||
      (request.headers["if-match"] &&
        request.headers["if-match"] !== (previous && etag(previous)))
    ) {
      return fail(response, 412, "PreconditionFailed");
    }
    if (
      (mode === "snapshot-failure" && key !== currentKey) ||
      (mode === "current-failure" && key === currentKey)
    ) {
      return fail(response, 503, "ServiceUnavailable");
    }
    objects.set(
      key,
      mode === "snapshot-corrupt" && key !== currentKey
        ? Buffer.from("corrupted snapshot")
        : body,
    );
    if (mode === "lost-response" && key === currentKey) {
      return request.socket.destroy();
    }
    response.writeHead(200, { etag: etag(body) });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    objects,
    requests,
    currentPut,
    uploadClosed,
  };
}

// A first-party, narrowly scoped attachment sink. File authority stays in WSS.
// Published verbatim: sourcemap debug-ID injection excludes this immutable script.
const PREFIX = "/sandbox-file-downloads/v1/";
const CHUNK_BYTES = 32_768;
const IDLE_MS = 30_000;
const pending = new Map();
const owners = new Map();

function retire(entry, type, code = "unavailable") {
  if (entry.closed) {
    return;
  }
  entry.closed = true;
  self.clearTimeout(entry.timer);
  pending.delete(entry.id);
  owners.delete(entry.owner);
  if (type !== "complete") {
    const error = new Error("File download interrupted");
    entry.controller?.error(error);
    // controller.error owns stream failure; settle the outstanding pull once.
    entry.pull?.resolve();
  }
  entry.pull = null;
  entry.port.postMessage(type === "error" ? { type, code } : { type });
  entry.port.close();
  entry.done.resolve();
}

// This standalone classic worker has no module imports. Its synchronous idle
// callback is owned by the entry and cleared on every touch and retirement.
function touch(entry) {
  self.clearTimeout(entry.timer);
  entry.timer = self.setTimeout(() => retire(entry, "error"), IDLE_MS);
}

function fileSize(value) {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n
  );
}

function filename(value) {
  const safe =
    value
      .replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069/\\]/gu, "_")
      .replace(/^[. ]+|[. ]+$/g, "") || "download";
  return encodeURIComponent(safe.toWellFormed()).replace(
    /[!'()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function isPreparation(data, source) {
  return !(
    !source ||
    source.type !== "window" ||
    new URL(source.url).origin !== self.location.origin ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.type !== "prepare" ||
    data.version !== 1
  );
}

self.addEventListener("message", (event) => {
  const data = event.data;
  const port = event.ports[0];
  const source = event.source;
  if (!port) {
    return;
  }
  if (!isPreparation(data, source)) {
    port.postMessage({ type: "error", code: "updateRequired" });
    port.close();
    return;
  }
  if (
    event.ports.length !== 1 ||
    Object.keys(data).length !== 5 ||
    typeof data.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      data.id,
    ) ||
    !fileSize(data.size) ||
    typeof data.name !== "string" ||
    !data.name.length ||
    // Match fs v3's bounded display label, including escaped non-UTF-8 names.
    new TextEncoder().encode(data.name).byteLength > 4096 ||
    pending.has(data.id) ||
    owners.has(source.id) ||
    owners.size >= 16
  ) {
    port.postMessage({ type: "error", code: "unavailable" });
    port.close();
    return;
  }
  const entry = {
    id: data.id,
    owner: source.id,
    name: filename(data.name),
    size: BigInt(data.size),
    offset: 0n,
    port,
    closed: false,
    claimed: false,
    controller: null,
    pull: null,
    done: Promise.withResolvers(),
    timer: null,
  };
  pending.set(entry.id, entry);
  owners.set(entry.owner, entry);
  touch(entry);
  port.addEventListener("messageerror", () => retire(entry, "error"));
  port.addEventListener("message", (message) => {
    const chunk = message.data;
    if (entry.closed) {
      return;
    }
    if (chunk?.type === "abort") {
      retire(entry, "cancelled");
      return;
    }
    const length = Number(
      entry.size - entry.offset > BigInt(CHUNK_BYTES)
        ? BigInt(CHUNK_BYTES)
        : entry.size - entry.offset,
    );
    if (
      !entry.pull ||
      !chunk ||
      typeof chunk !== "object" ||
      Array.isArray(chunk) ||
      Object.keys(chunk).length !== 4 ||
      chunk.type !== "chunk" ||
      chunk.offset !== entry.offset.toString() ||
      !(chunk.data instanceof ArrayBuffer) ||
      chunk.data.byteLength !== length ||
      !length ||
      chunk.final !== (entry.offset + BigInt(length) === entry.size)
    ) {
      retire(entry, "error");
      return;
    }
    const pull = entry.pull;
    entry.pull = null;
    entry.offset += BigInt(length);
    entry.controller.enqueue(new Uint8Array(chunk.data));
    if (chunk.final) {
      entry.controller.close();
      retire(entry, "complete");
    } else {
      touch(entry);
    }
    pull.resolve();
  });
  port.start();
  port.postMessage({ type: "ready", version: 1, id: entry.id });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) {
    return;
  }
  const reject = (status) =>
    new Response(null, {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 405 ? { Allow: "GET" } : {}),
      },
    });
  const id = url.pathname.slice(PREFIX.length);
  const entry = pending.get(id);
  if (event.request.method !== "GET") {
    event.respondWith(reject(405));
    return;
  }
  if (url.search || event.request.headers.has("Range")) {
    event.respondWith(reject(416));
    return;
  }
  if (!entry || entry.closed || entry.claimed) {
    event.respondWith(reject(404));
    return;
  }
  entry.claimed = true;
  touch(entry);
  const stream =
    entry.size === 0n
      ? null
      : new ReadableStream(
          {
            start(controller) {
              entry.controller = controller;
            },
            pull() {
              if (entry.closed || entry.pull) {
                throw new Error("Invalid download demand");
              }
              const pull = Promise.withResolvers();
              entry.pull = pull;
              touch(entry);
              entry.port.postMessage({
                type: "pull",
                offset: entry.offset.toString(),
                length: Number(
                  entry.size - entry.offset > BigInt(CHUNK_BYTES)
                    ? BigInt(CHUNK_BYTES)
                    : entry.size - entry.offset,
                ),
              });
              return pull.promise;
            },
            cancel() {
              retire(entry, "cancelled");
            },
          },
          { highWaterMark: 0 },
        );
  event.respondWith(
    new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": entry.size.toString(),
        "Content-Disposition":
          "attachment; filename=\"download\"; filename*=UTF-8''" + entry.name,
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
        "Accept-Ranges": "none",
      },
    }),
  );
  event.waitUntil(entry.done.promise);
  if (entry.size === 0n) {
    retire(entry, "complete");
  }
});

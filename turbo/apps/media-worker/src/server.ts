import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { z } from "zod";
import { POSTER_ERROR_STATUS, PosterError } from "./poster-error";
import { renderPoster } from "./render";

const MAX_REQUEST_BYTES = 8 * 1024;
const requestSchema = z.object({
  sourceUrl: z
    .url()
    .max(4096)
    .refine((value) => {
      const { protocol } = new URL(value);
      return protocol === "https:" || protocol === "http:";
    }),
});

interface ServerConfig {
  readonly secret: string;
  readonly port: number;
  readonly maxConcurrency: number;
  readonly requestTimeoutMs: number;
}

function authorized(request: IncomingMessage, secret: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readSourceUrl(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = chunk as Buffer;
    size += data.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(data);
  }
  const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return requestSchema.parse(json).sourceUrl;
}

/**
 * One synchronous render endpoint. The caller owns retries and scheduling, so a
 * failed render reports a code and never queues work of its own.
 */
export function createPosterServer(config: ServerConfig): Server {
  let active = 0;
  return createServer((request, response) => {
    const send = (status: number, body: object) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    };
    if (request.method === "GET" && request.url === "/health") {
      send(200, { ok: true, revision: process.env.GIT_COMMIT_SHA ?? null });
      return;
    }
    if (request.method !== "POST" || request.url !== "/poster") {
      send(404, { code: "not_found" });
      return;
    }
    if (!authorized(request, config.secret)) {
      send(401, { code: "unauthorized" });
      return;
    }
    if (active >= config.maxConcurrency) {
      send(503, { code: "busy" });
      return;
    }
    active += 1;
    const owner = new AbortController();
    const signal = AbortSignal.any([
      owner.signal,
      AbortSignal.timeout(config.requestTimeoutMs),
    ]);
    // A disconnected caller has already given up on this render.
    response.once("close", () => {
      owner.abort();
    });
    void (async () => {
      try {
        let sourceUrl: string;
        try {
          sourceUrl = await readSourceUrl(request);
        } catch {
          send(400, { code: "invalid_request" });
          return;
        }
        const image = await renderPoster(sourceUrl, signal);
        if (response.writableEnded) {
          return;
        }
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": image.length,
        });
        response.end(image);
      } catch (error) {
        const code =
          error instanceof PosterError
            ? error.code
            : signal.aborted
              ? "timeout"
              : "render_failed";
        if (!response.writableEnded) {
          send(POSTER_ERROR_STATUS[code], { code });
        }
      } finally {
        active -= 1;
        owner.abort();
      }
    })();
  });
}

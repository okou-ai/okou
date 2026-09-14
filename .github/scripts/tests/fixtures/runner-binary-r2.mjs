import { createHash, createHmac } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { dirname, join } from "node:path";

const [root, layout] = process.argv.slice(2);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();

// Reject invalid authentication, including a hash that does not cover PUT bytes.
function signedCorrectly(request, body) {
  const match = request.headers.authorization?.match(
    /^AWS4-HMAC-SHA256 Credential=(test|fixture)-access\/(\d{8}\/auto\/s3\/aws4_request), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/,
  );
  if (!match) return false;
  const [, fixture, scope, signedHeaders, signature] = match;
  const payloadHash = request.headers["x-amz-content-sha256"] ?? sha256(body);
  if (payloadHash !== sha256(body)) return false;
  const canonicalHeaders = signedHeaders
    .split(";")
    .map(
      (key) => `${key}:${request.headers[key]?.trim().replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonical = [
    request.method,
    request.url,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    request.headers["x-amz-date"],
    scope,
    sha256(canonical),
  ].join("\n");
  let key = `AWS4${fixture}-secret`;
  for (const part of scope.split("/")) key = hmac(key, part);
  return hmac(key, stringToSign).toString("hex") === signature;
}

const retried = new Set();
const server = createServer(
  {
    key: readFileSync(join(root, "key.pem")),
    cert: readFileSync(join(root, "cert.pem")),
  },
  async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const mode = request.headers["x-fixture-mode"];
    const key = request.url.split("/").slice(2).join("/");
    const object = join(
      root,
      "store",
      layout === "single"
        ? "object.zst"
        : layout === "target"
          ? `${key.split("/")[1]}.zst`
          : key,
    );
    const error = (status) => {
      response.writeHead(status);
      response.end(
        "PreconditionFailed 412 X-Amz-Signature=fixture-sensitive-query supersecret",
      );
    };
    if (!signedCorrectly(request, body)) return error(403);
    appendFileSync(join(root, "r2.log"), `${request.method} ${key}\n`);
    if (mode === "redirect") {
      response.writeHead(307, { location: "https://example.invalid/redirect" });
      return response.end();
    }
    if (mode === "retry-once" && !retried.has(`${request.method}:${key}`)) {
      retried.add(`${request.method}:${key}`);
      return error(503);
    }
    if (request.method === "PUT") {
      if (
        mode === "put-fail" ||
        (mode === "binary" && key.endsWith(".zst")) ||
        (mode === "manifest" && key.endsWith(".json"))
      )
        return error(403);
      if (mode === "manifest-precondition" && key.endsWith(".json"))
        return error(412);
      if (request.headers["if-none-match"] === "*" && existsSync(object))
        return error(412);
      mkdirSync(dirname(object), { recursive: true });
      writeFileSync(object, body);
      response.writeHead(200);
      return response.end();
    }
    if (!existsSync(object)) return error(404);
    const stored = readFileSync(object);
    if (request.method === "HEAD") {
      if (mode === "head-fail") return error(403);
      const length =
        mode === "oversized-head"
          ? 67108865
          : mode === "size-mismatch"
            ? 1
            : stored.length;
      response.writeHead(
        200,
        mode === "malformed-head" ? {} : { "content-length": length },
      );
      return response.end();
    }
    if (request.method === "GET") {
      if (mode === "get-fail" || mode === "get") return error(403);
      if (mode === "disconnect") {
        response.writeHead(200, { "content-length": stored.length });
        response.end(stored.subarray(0, 1));
        return;
      }
      const range = request.headers.range?.match(/^bytes=0-(\d+)$/);
      const ranged = range && mode !== "ignore-range";
      const bytes = ranged ? stored.subarray(0, Number(range[1]) + 1) : stored;
      response.writeHead(ranged ? 206 : 200, {
        "content-length": bytes.length,
        ...(ranged
          ? { "content-range": `bytes 0-${bytes.length - 1}/${stored.length}` }
          : {}),
      });
      return response.end(bytes);
    }
    error(405);
  },
);
server.listen(0, "127.0.0.1", () => console.log(server.address().port));

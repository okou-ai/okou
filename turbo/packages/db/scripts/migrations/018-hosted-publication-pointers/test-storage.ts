import { readFile, writeFile } from "node:fs/promises";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { z } from "zod";
import { assert, sha256 } from "./model";

// Subprocess preload used only by test-integration.ts. It intercepts the AWS
// SDK's HTTP boundary, including condition headers, while the real CLI and real
// PostgreSQL transactions run unchanged. Unknown requests never reach a network.
export const storageStateSchema = z.object({
  objects: z.record(
    z.string(),
    z.object({
      bytes: z.string(),
      contentType: z.string(),
      etag: z.string(),
    }),
  ),
  puts: z.number().int().nonnegative(),
  failAlias: z.string().nullable(),
  failuresRemaining: z.number().int().nonnegative(),
  revokeOnPut: z
    .object({ key: z.string(), policyKey: z.string() })
    .nullable()
    .optional(),
});
export type StorageState = z.infer<typeof storageStateSchema>;

export const testEnvironment = z
  .object({
    HOSTED_MIGRATION_TEST_STORAGE: z.string().optional(),
    HOSTED_MIGRATION_TEST_DATABASE_URL: z.string().optional(),
  })
  .parse(process.env);

function errorResponse(code: string, status: number) {
  return new HttpResponse(
    `<Error><Code>${code}</Code><Message>Test storage boundary</Message></Error>`,
    {
      status,
      headers: { "Content-Type": "application/xml" },
    },
  );
}

const statePath = testEnvironment.HOSTED_MIGRATION_TEST_STORAGE;
if (statePath) {
  assert(
    process.env.R2_ACCOUNT_ID === "migration018-test",
    "test_storage_account_required",
  );
  const server = setupServer(
    http.all(
      /^https:\/\/(?:[^/]+\.)?migration018-test\.r2\.cloudflarestorage\.com\//u,
      async ({ request }) => {
        const state = storageStateSchema.parse(
          JSON.parse(await readFile(statePath, "utf8")),
        );
        const url = new URL(request.url);
        const key = decodeURIComponent(
          url.pathname.replace(/^\/(?:migration018-test-bucket\/)?/u, ""),
        );
        const previous = state.objects[key];
        if (request.method === "GET") {
          if (!previous) return errorResponse("NoSuchKey", 404);
          if (
            request.headers.has("if-match") &&
            request.headers.get("if-match") !== previous.etag
          ) {
            return errorResponse("PreconditionFailed", 412);
          }
          const bytes = Buffer.from(previous.bytes, "base64");
          return new HttpResponse(new Uint8Array(bytes).buffer, {
            headers: {
              "Content-Type": previous.contentType,
              "Content-Length": String(bytes.byteLength),
              ETag: previous.etag,
            },
          });
        }
        if (request.method !== "PUT")
          return errorResponse("MethodNotAllowed", 405);
        if (request.headers.get("if-none-match") === "*" && previous)
          return errorResponse("PreconditionFailed", 412);
        if (
          request.headers.has("if-match") &&
          request.headers.get("if-match") !== previous?.etag
        ) {
          return errorResponse("PreconditionFailed", 412);
        }
        if (key === state.failAlias && state.failuresRemaining > 0) {
          state.failuresRemaining -= 1;
          await writeFile(statePath, JSON.stringify(state));
          return errorResponse("PreconditionFailed", 412);
        }
        const bytes = Buffer.from(await request.arrayBuffer());
        const etag = `"${sha256(bytes)}"`;
        state.objects[key] = {
          bytes: bytes.toString("base64"),
          contentType:
            request.headers.get("content-type") ?? "application/octet-stream",
          etag,
        };
        state.puts += 1;
        if (state.revokeOnPut?.key === key) {
          const policyKey = state.revokeOnPut.policyKey;
          const storedPolicy = state.objects[policyKey];
          assert(storedPolicy, "missing_test_policy");
          const policy = z
            .record(z.string(), z.unknown())
            .parse(
              JSON.parse(
                Buffer.from(storedPolicy.bytes, "base64").toString("utf8"),
              ),
            );
          const revoked = Buffer.from(
            JSON.stringify({
              ...policy,
              audience: "private",
              status: "revoked",
              publicToken: null,
            }),
          );
          state.objects[policyKey] = {
            bytes: revoked.toString("base64"),
            contentType: "application/json",
            etag: `"${sha256(revoked)}"`,
          };
          state.revokeOnPut = null;
        }
        await writeFile(statePath, JSON.stringify(state));
        return new HttpResponse(null, { headers: { ETag: etag } });
      },
    ),
  );
  server.listen({ onUnhandledRequest: "error" });
}

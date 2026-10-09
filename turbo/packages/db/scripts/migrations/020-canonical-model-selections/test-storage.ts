import { readFile, writeFile } from "node:fs/promises";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Client } from "pg";
import { z } from "zod";

export const storageStateSchema = z.object({
  objects: z.record(z.string(), z.string()),
  puts: z.number(),
  advance: z
    .object({
      user: z.string(),
      org: z.string(),
      key: z.string(),
      seq: z.number(),
    })
    .nullable(),
  failPut: z.boolean(),
});
const { MODEL_SELECTION_TEST_STORAGE: file } = z
  .object({ MODEL_SELECTION_TEST_STORAGE: z.string().optional() })
  .parse(process.env);
if (file) {
  const server = setupServer(
    http.all(
      /^https:\/\/(?:[^/]+\.)?selection020-test\.r2\.cloudflarestorage\.com\//u,
      async ({ request }) => {
        const state = storageStateSchema.parse(
          JSON.parse(await readFile(file, "utf8")),
        );
        const key = decodeURIComponent(
          new URL(request.url).pathname.replace(
            /^\/(?:selection020-test-bucket\/)?/u,
            "",
          ),
        );
        if (request.method === "GET") {
          const value = state.objects[key];
          if (value === undefined)
            return new HttpResponse("<Error><Code>NoSuchKey</Code></Error>", {
              status: 404,
            });
          const bytes = Buffer.from(value, "base64");
          return new HttpResponse(new Uint8Array(bytes).buffer, {
            headers: {
              "Content-Length": String(bytes.length),
              "Content-Type": "application/octet-stream",
            },
          });
        }
        if (request.method !== "PUT")
          throw new Error("unexpected_test_storage_operation");
        if (
          state.objects[key] !== undefined &&
          request.headers.get("if-none-match") === "*"
        ) {
          return new HttpResponse(
            "<Error><Code>PreconditionFailed</Code></Error>",
            { status: 412, headers: { "Content-Type": "application/xml" } },
          );
        }
        if (state.failPut)
          return new HttpResponse("<Error><Code>AccessDenied</Code></Error>", {
            status: 403,
            headers: { "Content-Type": "application/xml" },
          });
        if (request.headers.get("if-none-match") !== "*")
          throw new Error("unconditional_test_storage_write");
        state.objects[key] = Buffer.from(await request.arrayBuffer()).toString(
          "base64",
        );
        state.puts++;
        if (state.advance) {
          const db = new Client({ connectionString: process.env.DATABASE_URL });
          try {
            await db.connect();
            await db.query(
              `UPDATE chat_thread_snapshots SET object_key = $1, latest_event_seq_id = $2, updated_at = now()
          WHERE user_id = $3 AND org_id = $4`,
              [
                state.advance.key,
                state.advance.seq,
                state.advance.user,
                state.advance.org,
              ],
            );
          } finally {
            await db.end();
          }
          state.advance = null;
        }
        await writeFile(file, JSON.stringify(state));
        return new HttpResponse(null, {
          headers: { ETag: '"selection020-test"' },
        });
      },
    ),
  );
  server.listen({ onUnhandledRequest: "error" });
}

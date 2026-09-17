import { appendFileSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Supply the build-time constants when exercising the unchanged source entry point.
Object.assign(globalThis, {
  __CLI_VERSION__: "0.0.0-test",
  __DEFAULT_SENTRY_DSN__: "",
});

const [log, failPage] = process.argv.splice(2, 2);
if (!log) throw new Error("Missing fixture request log");
const server = setupServer(
  http.post(
    "http://social-fixture.invalid/api/social/request",
    async ({ request }) => {
      const body: unknown = await request.json();
      appendFileSync(log, `${JSON.stringify(body)}\n`);
      const input =
        typeof body === "object" && body !== null && "input" in body
          ? body.input
          : null;
      const cursor =
        typeof input === "object" && input !== null && "cursor" in input
          ? input.cursor
          : undefined;
      if (cursor && failPage === "1") {
        return HttpResponse.json(
          {
            error: {
              code: "UPSTREAM_ERROR",
              message: "Temporary page failure",
              retryable: true,
            },
          },
          { status: 502 },
        );
      }
      const ids = cursor ? ["four"] : ["one", "two", "three"];
      return HttpResponse.json({
        tool: "instagram_comments",
        billingCategory: "request",
        billingQuantity: 1,
        creditsCharged: 3,
        collection: cursor
          ? { state: "complete", itemsReturned: 1 }
          : { state: "more", itemsReturned: 3, nextInput: { cursor: "next" } },
        result: {
          comments: ids.map((id) => {
            return { id };
          }),
          hasMore: !cursor,
        },
      });
    },
  ),
);
server.listen({ onUnhandledRequest: "error" });
process.once("exit", () => {
  return server.close();
});

import * as Sentry from "@sentry/node";
import { http, HttpResponse } from "msw";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

import { server } from "../mocks/server";

const envelopeItemHeader = z.object({ type: z.string() });

afterEach(async () => {
  await Sentry.close();
  vi.unstubAllEnvs();
});

test("reports programmer errors while excluding operational errors and logs", async () => {
  const envelopes: string[] = [];
  server.use(
    http.post("https://sentry.example/api/1/envelope/", async ({ request }) => {
      envelopes.push(await request.text());
      return HttpResponse.json({});
    }),
  );
  vi.stubEnv("SENTRY_DSN", "https://public@sentry.example/1");

  await import("../instrument");
  Sentry.captureException(new Error("programmer error regression"));
  Sentry.captureException(new Error("not authenticated"));
  Sentry.logger.info("log regression");
  await expect(Sentry.flush(2000)).resolves.toBeTruthy();

  const items = envelopes.flatMap((envelope) => {
    const lines = envelope.split("\n");
    const result: { type: string; payload: unknown }[] = [];
    for (let index = 1; index + 1 < lines.length; index += 2) {
      const header = envelopeItemHeader.parse(JSON.parse(lines[index]!));
      result.push({
        type: header.type,
        payload: JSON.parse(lines[index + 1]!),
      });
    }
    return result;
  });
  expect(
    items.filter((item) => {
      return item.type === "event";
    }),
  ).toStrictEqual([
    {
      type: "event",
      payload: expect.objectContaining({
        tags: expect.objectContaining({ app: "cli" }),
        exception: expect.objectContaining({
          values: [
            expect.objectContaining({ value: "programmer error regression" }),
          ],
        }),
      }),
    },
  ]);
  expect(
    items.map((item) => {
      return item.type;
    }),
  ).not.toContain("log");
});

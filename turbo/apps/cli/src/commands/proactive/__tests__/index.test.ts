import { beforeEach, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createProactiveCommand } from "../index";

const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "test-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});

function run(...args: string[]) {
  return createProactiveCommand().parseAsync(["node", "okou", ...args]);
}

it.each([
  ["morning-brief", "morning-brief", "morning-brief"],
  ["suggestions", "proactive-suggestions", "proactive-suggestions/with-feed"],
])(
  "reads, enables and disables %s in the authenticated workspace",
  async (feature, readPath, writePath) => {
    let enabled = false;
    const response = () => {
      return {
        enabled,
        status: enabled ? "preparing" : "paused",
        unavailableReason: null,
      };
    };
    server.use(
      http.get(
        `http://localhost:3000/api/preferences/${readPath}`,
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json(response());
        },
      ),
      http.put(
        `http://localhost:3000/api/preferences/${writePath}`,
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          const body = await request.json();
          expect(body).toStrictEqual({ enabled: !enabled });
          enabled = !enabled;
          return HttpResponse.json(response());
        },
      ),
    );
    await run("status", feature, "--json");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toStrictEqual({
      feature,
      ...response(),
    });
    await run("enable", feature, "--json");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toStrictEqual({
      feature,
      enabled: true,
      status: "preparing",
      unavailableReason: null,
    });
    await run("disable", feature, "--json");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toStrictEqual({
      feature,
      enabled: false,
      status: "paused",
      unavailableReason: null,
    });
    await run("status", feature);
    expect(log.mock.calls).toContainEqual([`${feature}: off (status: paused)`]);
    expect(log.mock.calls).toContainEqual([
      `Check again: okou proactive status ${feature}`,
    ]);
  },
);

it("reports saved intent and the missing time zone instead of claiming Suggestions are running", async () => {
  server.use(
    http.put(
      "http://localhost:3000/api/preferences/proactive-suggestions/with-feed",
      () => {
        return HttpResponse.json({
          enabled: true,
          status: "preparing",
          unavailableReason: "missing-timezone",
        });
      },
    ),
  );
  await run("enable", "suggestions");
  expect(log.mock.calls).toContainEqual([
    "suggestions: on (status: preparing)",
  ]);
  expect(log.mock.calls).toContainEqual([
    "Set your time zone in Settings before this can run.",
  ]);
});

it.each([
  ["whats-new", "whatsNew"],
  ["offers", "offers"],
  ["system-updates", "systemUpdates"],
])(
  "reads and changes only the %s source preference",
  async (feature, source) => {
    let enabled = true;
    let sources = {
      suggestions: false,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    };
    server.use(
      http.get("http://localhost:3000/api/feed/sources", () => {
        return HttpResponse.json(sources);
      }),
      http.patch(
        "http://localhost:3000/api/feed/sources",
        async ({ request }) => {
          const body = await request.json();
          expect(body).toStrictEqual({ [source]: !enabled });
          enabled = !enabled;
          sources = { ...sources, [source]: enabled };
          return HttpResponse.json(sources);
        },
      ),
    );
    await run("status", feature, "--json");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toStrictEqual({
      feature,
      enabled: true,
    });
    await run("disable", feature, "--json");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toStrictEqual({
      feature,
      enabled: false,
    });
    await run("status", feature);
    expect(log.mock.calls).toContainEqual([`${feature}: off`]);
    await run("enable", feature, "--json");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toStrictEqual({
      feature,
      enabled: true,
    });
  },
);

it("reports saved preferences with setup errors separately from HTTP failures", async () => {
  server.use(
    http.put("http://localhost:3000/api/preferences/morning-brief", () => {
      return HttpResponse.json({
        enabled: true,
        status: "error",
        unavailableReason: null,
      });
    }),
  );
  await run("enable", "morning-brief");
  expect(log.mock.calls).toContainEqual(["morning-brief: on (status: error)"]);
  expect(log.mock.calls).toContainEqual([
    "The preference is saved, but setup needs attention in Settings.",
  ]);

  server.use(
    http.put("http://localhost:3000/api/preferences/morning-brief", () => {
      return HttpResponse.json(
        {
          error: { code: "FORBIDDEN", message: "Suggestions are not enabled." },
        },
        { status: 403 },
      );
    }),
  );
  await expect(run("disable", "morning-brief", "--json")).rejects.toThrow(
    "process.exit called",
  );
  expect(error.mock.calls.flat().join("\n")).toContain(
    "403: Suggestions are not enabled.",
  );
});

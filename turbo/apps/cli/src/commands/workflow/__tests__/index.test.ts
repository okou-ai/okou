import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { workflowCommand } from "../index";

const AGENT = "11111111-1111-4111-8111-111111111111";
const SHARED = "22222222-2222-4222-8222-222222222222";
const PRIVATE = "33333333-3333-4333-8333-333333333333";
const COPIED = "44444444-4444-4444-8444-444444444444";
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
const exit = vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("command failed");
});
function summary(id: string, visibility: "public" | "private") {
  return {
    id,
    name: "weekly-review",
    agentId: AGENT,
    agentName: "internal",
    agentDisplayName: "Internal executor",
    visibility,
    ownerUserId: "alice",
    official: null,
    shadowedBy:
      visibility === "public"
        ? { id: PRIVATE, name: "weekly-review", displayName: null }
        : null,
  };
}
function text() {
  return output.mock.calls.flat().join("\n");
}
beforeEach(() => {
  EventEmitter.prototype.emit.call(workflowCommand, "single-agent-mode", true);
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_header.${Buffer.from(JSON.stringify({ scope: "okou", capabilities: [], singleAgent: true })).toString("base64url")}.signature`,
  );
  vi.stubEnv("OKOU_AGENT_ID", "55555555-5555-4555-8555-555555555555");
  server.use(
    http.get("*/api/agents", () => {
      return HttpResponse.json([{ agentId: AGENT, isDefaultAgent: true }]);
    }),
  );
});
afterEach(() => {
  EventEmitter.prototype.emit.call(workflowCommand, "single-agent-mode", false);
  output.mockClear();
  errors.mockClear();
  exit.mockClear();
  vi.unstubAllEnvs();
});
test("lists the default workspace namespace and identifies the private slash override", async () => {
  server.use(
    http.get("*/api/workflows", ({ request }) => {
      expect(new URL(request.url).searchParams.get("agentId")).toBe(AGENT);
      return HttpResponse.json([
        summary(SHARED, "public"),
        summary(PRIVATE, "private"),
      ]);
    }),
  );
  await workflowCommand.parseAsync(["node", "okou", "list"]);
  expect(text()).toContain(SHARED);
  expect(text()).toContain(PRIVATE);
  expect(text()).toContain("Overridden for you by");
  expect(text()).toContain("/weekly-review");
  expect(text()).not.toContain("AGENT ID");
});
test("creates a private workspace workflow using the default executor instead of the runtime Agent ID", async () => {
  server.use(
    http.post("*/api/workflows", async ({ request }) => {
      expect(await request.json()).toMatchObject({
        agentId: AGENT,
        name: "weekly-review",
        instruction: "Review the week",
      });
      return HttpResponse.json(summary(PRIVATE, "private"), { status: 201 });
    }),
  );
  await workflowCommand.parseAsync([
    "node",
    "okou",
    "create",
    "weekly-review",
    "--instruction",
    "Review the week",
  ]);
  expect(text()).toContain(PRIVATE);
  expect(text()).not.toContain("Internal executor");
});
test("opens an existing private copy and preserves its contents", async () => {
  server.use(
    http.get(`*/api/workflows/${SHARED}`, () => {
      return HttpResponse.json(summary(SHARED, "public"));
    }),
    http.get("*/api/workflows", () => {
      return HttpResponse.json([
        summary(SHARED, "public"),
        summary(PRIVATE, "private"),
      ]);
    }),
  );
  await workflowCommand.parseAsync(["node", "okou", "copy", SHARED]);
  expect(text()).toContain(`Open it: okou workflow view ${PRIVATE}`);
});
test("makes a private copy without a destination flag and reports only the caller's copied automations", async () => {
  server.use(
    http.get(`*/api/workflows/${SHARED}`, () => {
      return HttpResponse.json(summary(SHARED, "public"));
    }),
    http.get("*/api/workflows", () => {
      return HttpResponse.json([summary(SHARED, "public")]);
    }),
    http.post(`*/api/workflows/${SHARED}/copy`, async ({ request }) => {
      expect(await request.json()).toStrictEqual({ toAgentId: AGENT });
      return HttpResponse.json(summary(COPIED, "private"), { status: 201 });
    }),
    http.get(`*/api/workflows/${COPIED}/automations`, () => {
      return HttpResponse.json([]);
    }),
  );
  await workflowCommand.parseAsync(["node", "okou", "copy", SHARED]);
  expect(text()).toContain(COPIED);
  expect(text()).toContain("Copied automations (0)");
});
test("publishes the resolved private ID once and never retries a disappeared override against public", async () => {
  server.use(
    http.get("*/api/workflows", () => {
      return HttpResponse.json([
        summary(SHARED, "public"),
        summary(PRIVATE, "private"),
      ]);
    }),
    http.post(`*/api/workflows/${PRIVATE}/publish`, () => {
      return HttpResponse.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "Private workflow no longer exists",
          },
        },
        { status: 404 },
      );
    }),
  );
  await expect(
    workflowCommand.parseAsync(["node", "okou", "publish", "weekly-review"]),
  ).rejects.toThrow("command failed");
  expect(errors.mock.calls.flat().join("\n")).toContain(
    "Private workflow no longer exists",
  );
});
test("uses the existing public publication and demotion APIs for explicit IDs", async () => {
  server.use(
    http.post(`*/api/workflows/${PRIVATE}/publish`, () => {
      return HttpResponse.json(summary(PRIVATE, "public"));
    }),
    http.post(`*/api/workflows/${SHARED}/demote`, () => {
      return HttpResponse.json(summary(SHARED, "private"));
    }),
  );
  await workflowCommand.parseAsync(["node", "okou", "publish", PRIVATE]);
  await workflowCommand.parseAsync(["node", "okou", "unpublish", SHARED]);
  expect(text()).toContain("now public");
  expect(text()).toContain("now private");
});
test("renders workspace examples and nested help without Agent targets", async () => {
  const help: string[] = [];
  workflowCommand.configureOutput({
    writeOut: (value) => {
      return help.push(value);
    },
  });
  workflowCommand.outputHelp();
  expect(help.join("\n")).toContain("publish");
  expect(help.join("\n")).toContain("Make private copy");
  expect(help.join("\n")).not.toContain("--to-agent");
  help.length = 0;
  const copy = workflowCommand.commands.find((cmd) => {
    return cmd.name() === "copy";
  });
  copy?.configureOutput({
    writeOut: (value) => {
      return help.push(value);
    },
  });
  copy?.outputHelp();
  expect(help.join("\n")).toContain("workflow copy");
  expect(help.join("\n")).not.toContain("--to-agent");
  expect(help.join("\n")).not.toContain("--agent");
});

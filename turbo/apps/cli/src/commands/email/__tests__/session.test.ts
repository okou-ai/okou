import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createEmailCommand } from "../index";

const api = "http://localhost:3000";
const binding = {
  emailAddress: "sender@example.com",
  workspace: { id: "org_current", name: "Current workspace" },
  workspaces: [
    { id: "org_current", name: "Current workspace" },
    { id: "org_other", name: "Other workspace" },
  ],
};
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("CLI exited");
});

beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "test-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", api);
  output.mockClear();
  errors.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function run(args: string[]) {
  return createEmailCommand().parseAsync(["node", "okou email", ...args]);
}

describe("Email workspace binding commands", () => {
  it("shows the bound sender, workspace and switch targets", async () => {
    server.use(
      http.get(`${api}/api/integrations/email/session`, () => {
        return HttpResponse.json(binding);
      }),
    );
    await run(["status"]);
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("sender@example.com");
    expect(text).toContain("Workspace: Current workspace (org_current)");
    expect(text).toContain("Other workspace (org_other)");
    expect(text).toContain("okou email switch --workspace-id <id>");
  });

  it("prints machine-readable binding status", async () => {
    server.use(
      http.get(`${api}/api/integrations/email/session`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json(binding);
      }),
    );
    await run(["status", "--json"]);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toStrictEqual(
      binding,
    );
  });

  it("switches only the workspace, leaving sender selection to the server", async () => {
    const result = {
      emailAddress: binding.emailAddress,
      workspace: binding.workspaces[1],
    };
    server.use(
      http.post(
        `${api}/api/integrations/email/session/workspace`,
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(await request.json()).toStrictEqual({
            workspaceId: "org_other",
          });
          return HttpResponse.json(result);
        },
      ),
    );
    await run(["switch", "--workspace-id", "org_other", "--json"]);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toStrictEqual(
      result,
    );
  });

  it("disconnects the current sender and prints the result", async () => {
    server.use(
      http.delete(`${api}/api/integrations/email/session`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({ emailAddress: binding.emailAddress });
      }),
    );
    await run(["logout", "--json"]);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toStrictEqual({
      emailAddress: binding.emailAddress,
    });
  });

  it("reports denied workspace changes without claiming success", async () => {
    server.use(
      http.post(`${api}/api/integrations/email/session/workspace`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message:
                "Choose a workspace you belong to from okou email status.",
            },
          },
          { status: 403 },
        );
      }),
    );
    await expect(
      run(["switch", "--workspace-id", "org_denied"]),
    ).rejects.toThrow("CLI exited");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Choose a workspace you belong to",
    );
    expect(output.mock.calls).toHaveLength(0);
  });
});

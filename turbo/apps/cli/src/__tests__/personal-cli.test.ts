import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { registerRequestedCommand } from "../okou";

function token() {
  return `vm0_sandbox_e30.${Buffer.from(
    JSON.stringify({
      scope: "okou",
      runId: "captured-run",
      userId: "member-a",
      orgId: "org-a",
      capabilities: [
        "instructions:read",
        "instructions:write",
        "chat-thread:read",
        "chat-thread:write",
        "connector:read",
      ],
    }),
  ).toString("base64url")}.signature`;
}

async function cli(args: string[]) {
  const command = new Command("okou").exitOverride();
  let output = "";
  command.configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: () => {},
  });
  await registerRequestedCommand(command, ["node", "okou", ...args]);
  return {
    command,
    help: async () => {
      await expect(
        command.parseAsync(["--help"], { from: "user" }),
      ).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      return output;
    },
  };
}

afterEach(() => {
  return vi.unstubAllEnvs();
});

describe("captured personal CLI help and dispatch", () => {
  it("advertises personal Instructions at the root", async () => {
    vi.stubEnv("OKOU_TOKEN", token());
    const { help } = await cli(["--help"]);
    const text = await help();
    expect(text).toContain("instructions");
    expect(text).toContain("okou instructions view");
  });

  it.each([
    ["chat", "create"],
    ["chat", "list"],
    ["chat", "move"],
    ["connector"],
    ["connector", "status"],
    ["connector", "permission-request"],
    ["connector", "custom", "list"],
    ["connector", "custom", "status"],
    ["connector", "custom", "create"],
    ["whoami"],
    ["search"],
  ])("loads help for enabled commands: %s %s", async (...path) => {
    vi.stubEnv("OKOU_TOKEN", token());
    const { command } = await cli(path);
    let selected = command;
    for (const name of path)
      selected = selected.commands.find((child) => {
        return child.name() === name;
      })!;
    let text = "";
    selected.configureOutput({
      writeOut: (line) => {
        text += line;
      },
    });
    selected.exitOverride();
    await expect(
      selected.parseAsync(["--help"], { from: "user" }),
    ).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    if (path[0] === "search") expect(text).toContain("agent-session");
    if (path[1] === "custom" && path[2] === "create") {
      expect(text).toContain('"authMode": "automatic"');
      expect(text).toContain('"oauthConfig": {');
      expect(text).toContain('"valueTemplate": "Bearer {{secrets.secret}}"');
      expect(text).toContain("Requires an organization admin");
    }
    if (path[1] === "custom" && path[2] !== "create") {
      const guidance = text.replaceAll(/\s+/g, " ");
      expect(guidance).toContain("including inside a Run");
      expect(guidance).toMatch(
        new RegExp(
          `Use connector ${path[2]} for the exact accounts? admitted to the Run`,
        ),
      );
    }
  });

  it("creates member chats", async () => {
    vi.stubEnv("OKOU_TOKEN", token());
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let created: unknown;
    server.use(
      http.post("*/api/chat-threads", async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(
          {
            threadId: "00000000-0000-4000-8000-000000000003",
            title: "Personal plan",
            selectedModel: null,
            serviceTier: null,
          },
          { status: 201 },
        );
      }),
    );
    try {
      const { command } = await cli([
        "chat",
        "create",
        "Personal plan",
        "--json",
      ]);
      await command.parseAsync(["chat", "create", "Personal plan", "--json"], {
        from: "user",
      });
      expect(created).toMatchObject({
        title: "Personal plan",
      });
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        title: "Personal plan",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("identifies the personal Run by its user and workspace", async () => {
    vi.stubEnv("OKOU_TOKEN", token());
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "personal-chat");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    server.use(
      http.get("*/api/org", () => {
        return HttpResponse.json({ id: "org-a", name: "Workspace A" });
      }),
    );
    try {
      const { command } = await cli(["whoami"]);
      await command.parseAsync(["whoami"], { from: "user" });
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("User ID:    member-a");
      expect(output).toContain("Chat ID:    personal-chat");
      expect(output).toContain("Run ID:     captured-run");
    } finally {
      log.mockRestore();
    }
  });

  it("uses the authenticated member endpoint for outside-Run identity", async () => {
    vi.stubEnv("OKOU_TOKEN", "member-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    server.use(
      http.get("*/api/auth/me", () => {
        return HttpResponse.json({
          userId: "outside-member",
          email: "member@example.com",
          orgId: "org-a",
        });
      }),
      http.get("*/api/org", () => {
        return HttpResponse.json({ id: "org-a", name: "Workspace A" });
      }),
    );
    try {
      const { command } = await cli(["whoami"]);
      await command.parseAsync(["whoami"], { from: "user" });
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("outside-member");
      expect(output).toContain("Workspace A");
    } finally {
      log.mockRestore();
    }
  });

  it("uses authenticated mode outside a Run for help as well as dispatch", async () => {
    vi.stubEnv("OKOU_TOKEN", "authenticated-member-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    const { help } = await cli(["--help"]);
    expect(await help()).toContain("okou instructions view");
  });
});

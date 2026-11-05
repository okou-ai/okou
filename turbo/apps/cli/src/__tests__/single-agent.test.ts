import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { registerRequestedCommand } from "../okou";

const executorId = "00000000-0000-4000-8000-000000000001";
function token(personal = true) {
  return `vm0_sandbox_e30.${Buffer.from(
    JSON.stringify({
      scope: "okou",
      runId: "captured-run",
      userId: "member-a",
      orgId: "org-a",
      capabilities: [
        "agent:read",
        "agent:write",
        "instructions:read",
        "instructions:write",
        "chat-thread:read",
        "chat-thread:write",
        "connector:read",
      ],
      ...(personal ? { singleAgent: true } : {}),
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
  it("hides product Agent management and advertises personal Instructions at the root", async () => {
    vi.stubEnv("OKOU_TOKEN", token());
    const { help } = await cli(["--help"]);
    const text = await help();
    expect(text).toContain("instructions");
    expect(text).toContain("okou instructions view");
    expect(text).not.toContain("View or manage agents");
    expect(text).not.toContain("okou agent --help");
    expect(text).not.toContain("cross-agent Projects");
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
  ])("keeps enabled help free of Agent selection: %s %s", async (...path) => {
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
    expect(text).not.toContain("--agent");
    expect(text).not.toContain("--all-agents");
    expect(text).not.toContain("agent access");
    if (path[0] === "search") expect(text).toContain("agent-session");
    if (path[1] === "custom" && path[2] === "create") {
      expect(text).toContain('"authMode": "automatic"');
      expect(text).toContain('"oauthConfig": {');
      expect(text).toContain('"valueTemplate": "Bearer {{secrets.secret}}"');
      expect(text).toContain("Requires an organization admin");
    }
    if (path[1] === "custom" && path[2] !== "create") {
      expect(text).toContain("including");
      expect(text).toContain("admitted to");
      expect(text).toContain("connector " + path[2]);
    }
  });

  it("rejects stale Agent mutations without requesting any Agent or Instructions write", async () => {
    vi.stubEnv("OKOU_TOKEN", token());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    let writes = 0;
    server.use(
      http.all("*/api/*", () => {
        writes++;
        return HttpResponse.json({});
      }),
    );
    try {
      const { command } = await cli([
        "agent",
        "edit",
        executorId,
        "--description",
        "shared role",
      ]);
      await expect(
        command.parseAsync(
          ["agent", "edit", executorId, "--description", "shared role"],
          { from: "user" },
        ),
      ).rejects.toThrow("exit");
      expect(error.mock.calls.flat().join("\n")).toContain(
        "Explicit Agent writes are not redirected",
      );
      expect(writes).toBe(0);
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("creates chats on the workspace executor instead of a retained non-default current Agent", async () => {
    vi.stubEnv("OKOU_TOKEN", token());
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_AGENT_ID", "00000000-0000-4000-8000-000000000002");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let created: unknown;
    server.use(
      http.get("*/api/agents", () => {
        return HttpResponse.json([
          {
            agentId: executorId,
            isDefaultAgent: true,
            ownerId: "workspace-owner",
            description: "Shared role",
            displayName: "Okou",
            sound: "friendly",
            avatarUrl: null,
            visibility: "public",
          },
        ]);
      }),
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
        agentId: executorId,
        title: "Personal plan",
      });
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
        agentId: executorId,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("identifies the personal Run by its user and workspace without exposing an Agent profile", async () => {
    vi.stubEnv("OKOU_TOKEN", token());
    vi.stubEnv("OKOU_AGENT_ID", executorId);
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
      expect(output).not.toContain("Agent ID:");
    } finally {
      log.mockRestore();
    }
  });

  it("uses the authenticated member endpoint for outside-Run identity", async () => {
    vi.stubEnv("OKOU_TOKEN", "member-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    server.use(
      http.get("*/api/feature-switches", () => {
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: { singleAgent: true },
        });
      }),
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
      expect(output).not.toContain("Invalid OKOU_TOKEN");
    } finally {
      log.mockRestore();
    }
  });

  it("preserves legacy help when the Run snapshot has no marker", async () => {
    vi.stubEnv("OKOU_TOKEN", token(false));
    const { help } = await cli(["--help"]);
    expect(await help()).toContain("okou agent --help");
    expect(await help()).not.toContain("Personal Instructions?");
    const { command } = await cli(["chat", "create"]);
    expect(
      command.commands[0]!.commands.find((child) => {
        return child.name() === "create";
      })!.helpInformation(),
    ).toContain("--agent");
  });

  it("uses authenticated mode outside a Run for help as well as dispatch", async () => {
    vi.stubEnv("OKOU_TOKEN", "authenticated-member-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    server.use(
      http.get("*/api/feature-switches", () => {
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: { singleAgent: true },
        });
      }),
    );
    const { help } = await cli(["--help"]);
    expect(await help()).toContain("okou instructions view");
    expect(await help()).not.toContain("okou agent --help");
  });
});

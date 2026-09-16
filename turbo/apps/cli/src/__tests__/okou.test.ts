import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildHelpText,
  program,
  registerCommands,
  registerRequestedCommand,
} from "../okou";

function buildOkouToken(capabilities: readonly string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({ scope: "okou", capabilities }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

describe("Okou CLI program", () => {
  registerCommands(program);
  const commandNames = program.commands.map((cmd) => {
    return cmd.name();
  });
  const canonicalCommandNames = commandNames.filter((name) => {
    return !name.startsWith("__");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should use the canonical Okou product identity", () => {
    expect(program.name()).toBe("okou");
    expect(program.description()).toBe(
      "Okou CLI — interact with Okou from inside the sandbox",
    );
  });

  it("should use Okou branding for the generate entry-point description", () => {
    const generateCommand = program.commands.find((command) => {
      return command.name() === "generate";
    });

    expect(generateCommand?.description()).toBe(
      "Generate assets via Okou's built-in pipelines or get connector skill-invocation guidance",
    );
  });

  it("should register all expected Okou commands", () => {
    const expectedCommands = [
      "model",
      "model-provider",
      "agent",
      "connector",
      "mcp",
      "ssh",
      "mail",
      "credit",
      "upgrade",
      "doctor",
      "search",
      "chat",
      "resource",
      "workflow",
      "slack",
      "feishu",
      "lark",
      "teams",
      "telegram",
      "github",
      "phone",
      "whoami",
      "intro",
      "computer-use",
      "browser",
      "generate",
      "web",
      "video",
      "host",
      "artifact",
      "presentation",
      "presentation-template",
      "maps",
      "weather",
      "scrape",
      "web-search",
      "people-search",
      "social",
      "image-recognition",
      "finance",
      "seo",
      "banking",
    ];
    for (const name of expectedCommands) {
      expect(canonicalCommandNames).toContain(name);
    }
  });

  it("should not include infrastructure or utility commands", () => {
    const excludedCommands = [
      "org",
      "auth",
      "compose",
      "volume",
      "run",
      "preference",
      "secret",
      "variable",

      "init",
      "info",
    ];
    for (const name of excludedCommands) {
      expect(commandNames).not.toContain(name);
    }
  });

  it("should keep internal commands out of the public surface", () => {
    expect(commandNames).toContain("__agent-loop");
    expect(commandNames).toContain("__intro-video-presenter");
    expect(commandNames).toContain("__intro-video-agent");
    expect(commandNames).toContain("__intro-video-voice");
    expect(canonicalCommandNames).not.toContain("__agent-loop");
    expect(canonicalCommandNames).not.toContain("__intro-video-presenter");
    expect(canonicalCommandNames).not.toContain("__intro-video-agent");
    expect(canonicalCommandNames).not.toContain("__intro-video-voice");
  });

  it("should have exactly 42 canonical commands", () => {
    expect(canonicalCommandNames).toHaveLength(42);
  });
});

describe("Okou CLI lazy command loading", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [],
    ["file:write"],
    ["file:read"],
    ["artifact:read"],
    ["artifact:write"],
  ])(
    "shows artifacts with a visibility or download capability: %j",
    (...capabilities: string[]) => {
      vi.stubEnv("OKOU_TOKEN", buildOkouToken(capabilities));
      const cli = new Command("okou");
      registerCommands(cli);
      expect(cli.helpInformation().includes("artifact")).toBe(
        capabilities.some((capability) => {
          return (
            capability.startsWith("artifact:") || capability === "file:read"
          );
        }),
      );
      expect(buildHelpText().includes("okou artifact --help")).toBe(
        capabilities.some((capability) => {
          return (
            capability.startsWith("artifact:") || capability === "file:read"
          );
        }),
      );
    },
  );

  it.each([[], ["ssh:read"], ["ssh:write"]])(
    "shows SSH only with an eligible Run capability: %j",
    (...capabilities) => {
      vi.stubEnv(
        "OKOU_TOKEN",
        capabilities.length ? buildOkouToken(capabilities) : "",
      );
      const cli = new Command("okou");
      registerCommands(cli);
      expect(cli.helpInformation().includes("ssh")).toBe(
        capabilities.length > 0,
      );
    },
  );

  it.each([[], ["feishu:write"], ["lark:write"]])(
    "shows Lark only with its own capability: %j",
    (...capabilities: string[]) => {
      vi.stubEnv("OKOU_TOKEN", buildOkouToken(capabilities));
      const cli = new Command("okou");
      registerCommands(cli);
      expect(cli.helpInformation().includes("lark")).toBe(
        capabilities.includes("lark:write"),
      );
      expect(buildHelpText().includes("okou lark message send --help")).toBe(
        capabilities.includes("lark:write"),
      );
    },
  );

  it.each([
    {
      label: "artifact sharing help invocation",
      argv: ["node", "okou", "artifact", "--help"],
      expectedName: "artifact",
      expectedHelpCode: "commander.helpDisplayed",
    },
    {
      label: "Lark help invocation",
      argv: ["node", "okou", "lark", "--help"],
      expectedName: "lark",
      expectedHelpCode: "commander.helpDisplayed",
    },
    {
      label: "direct canonical invocation",
      argv: ["node", "okou", "image-recognition", "--help"],
      expectedName: "image-recognition",
      expectedHelpCode: "commander.helpDisplayed",
    },
    {
      label: "canonical help invocation",
      argv: ["node", "okou", "help", "image-recognition"],
      expectedName: "image-recognition",
      expectedHelpCode: "commander.help",
    },
  ])(
    "should lazy-load $label",
    async ({ argv, expectedName, expectedHelpCode }) => {
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken([
          expectedName === "lark"
            ? "lark:write"
            : expectedName === "artifact"
              ? "artifact:read"
              : "image-recognition:write",
        ]),
      );
      let helpOutput = "";
      const prog = new Command()
        .name("okou")
        .exitOverride()
        .configureOutput({
          writeOut: (text: string) => {
            helpOutput += text;
          },
        });

      await registerRequestedCommand(prog, argv);

      expect(prog.commands).toHaveLength(1);
      const loadedCommand = prog.commands[0];
      expect(loadedCommand?.name()).toBe(expectedName);
      loadedCommand?.exitOverride().configureOutput({
        writeOut: (text: string) => {
          helpOutput += text;
        },
      });
      await expect(prog.parseAsync(argv)).rejects.toMatchObject({
        code: expectedHelpCode,
      });
      expect(helpOutput).toContain(`Usage: okou ${expectedName}`);
    },
  );

  it("should reject help for an unknown command", async () => {
    const argv = ["node", "okou", "help", "not-a-command"];
    vi.stubEnv("OKOU_TOKEN", buildOkouToken(["image-recognition:write"]));
    let errorOutput = "";
    const prog = new Command()
      .name("okou")
      .exitOverride()
      .configureOutput({
        writeErr: (text: string) => {
          errorOutput += text;
        },
      });

    await registerRequestedCommand(prog, argv);

    await expect(prog.parseAsync(argv)).rejects.toMatchObject({
      code: "commander.unknownCommand",
    });
    expect(errorOutput).toContain("unknown command 'not-a-command'");
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { Command, Help } from "commander";
import { buildHelpText, registerCommands } from "../okou";
import { generateCommand } from "../commands/generate";
import { decodeSandboxTokenPayload } from "../lib/api/sandbox-token";

function buildOkouToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function buildCommands(): Command[] {
  return [
    new Command("org"),
    new Command("model"),
    new Command("model-provider"),
    new Command("agent"),
    new Command("connector"),
    new Command("mcp"),
    new Command("run"),
    new Command("credit"),
    new Command("upgrade"),
    new Command("chat"),
    new Command("resource"),
    new Command("schedule"),
    new Command("github"),
    new Command("slack"),
    new Command("feishu"),
    new Command("teams"),
    new Command("telegram"),
    new Command("phone"),
    new Command("whoami"),
    new Command("browser"),
    new Command("generate"),
    new Command("web"),
    new Command("host"),
    new Command("maps"),
    new Command("weather"),
    new Command("scrape"),
    new Command("people-search"),
    new Command("web-search"),
    new Command("social"),
    new Command("image-recognition"),
    new Command("finance"),
    new Command("seo"),
    new Command("banking"),
  ];
}

function buildProgram(): Command {
  const prog = new Command();
  registerCommands(prog, buildCommands());
  return prog;
}

function visibleCommandNames(prog: Command): string[] {
  return new Help()
    .visibleCommands(prog)
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return name !== "help";
    });
}

function hiddenCommandNames(prog: Command): string[] {
  const visible = new Set(visibleCommandNames(prog));
  return prog.commands
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return !visible.has(name);
    });
}

function registeredCommandNames(prog: Command): string[] {
  return prog.commands.map((command) => {
    return command.name();
  });
}

describe("decodeSandboxTokenPayload", () => {
  it("should decode payload from a valid okou-scoped token", () => {
    const token = buildOkouToken({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "okou",
      capabilities: ["agent:read", "connector:read"],
      iat: 1000,
      exp: 2000,
    });
    const payload = decodeSandboxTokenPayload(token);
    expect(payload).toEqual({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "okou",
      capabilities: ["agent:read", "connector:read"],
      iat: 1000,
      exp: 2000,
    });
  });

  it("should decode payload from a valid okou-scoped token", () => {
    const token = buildOkouToken({
      userId: "user-okou",
      runId: "run-okou",
      orgId: "org-okou",
      scope: "okou",
      capabilities: ["agent:read"],
      iat: 1000,
      exp: 2000,
    });

    expect(decodeSandboxTokenPayload(token)).toMatchObject({
      userId: "user-okou",
      scope: "okou",
      capabilities: ["agent:read"],
    });
  });

  it("should return undefined for token without vm0_sandbox_ prefix", () => {
    expect(decodeSandboxTokenPayload("some-other-token")).toBeUndefined();
  });

  it("should return undefined for malformed JWT (not 3 parts)", () => {
    expect(
      decodeSandboxTokenPayload("vm0_sandbox_only-one-part"),
    ).toBeUndefined();
  });

  it("should return undefined for a non-okou scope", () => {
    const token = buildOkouToken({
      scope: "sandbox",
      capabilities: ["agent:read"],
    });
    expect(decodeSandboxTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined when capabilities is not an array", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: "not-an-array",
    });
    expect(decodeSandboxTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined for invalid base64 payload", () => {
    expect(
      decodeSandboxTokenPayload("vm0_sandbox_a.!!!invalid.c"),
    ).toBeUndefined();
  });
});

describe("registerCommands", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["vnc:read", "vnc:write"])(
    "shows VNC discovery with %s capability",
    (capability) => {
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({ scope: "okou", capabilities: [capability] }),
      );
      const prog = new Command();
      registerCommands(prog, [new Command("vnc")]);

      expect(visibleCommandNames(prog)).toContain("vnc");
    },
  );

  it.each([
    undefined,
    "personal-token",
    buildOkouToken({ scope: "okou", capabilities: [] }),
    buildOkouToken({ scope: "okou", capabilities: ["ssh:read", "ssh:write"] }),
  ])("hides VNC discovery without its Run capability (%s)", (token) => {
    vi.stubEnv("OKOU_TOKEN", token);
    const prog = new Command();
    registerCommands(prog, [new Command("vnc")]);

    expect(registeredCommandNames(prog)).toContain("vnc");
    expect(hiddenCommandNames(prog)).toContain("vnc");
  });

  it("should register globally enabled commands when OKOU_TOKEN is absent", () => {
    vi.stubEnv("OKOU_TOKEN", undefined);

    const prog = buildProgram();
    expect(hiddenCommandNames(prog)).toEqual([
      "mcp",
      "run",
      "image-recognition",
    ]);
    expect(registeredCommandNames(prog)).toContain("upgrade");
    expect(visibleCommandNames(prog)).toContain("browser");
  });

  it("should show presentation screenshots to external workspaces", () => {
    vi.stubEnv(
      "OKOU_TOKEN",
      buildOkouToken({
        userId: "user-external",
        orgId: "org-external",
        scope: "okou",
        capabilities: [],
      }),
    );
    const prog = new Command();

    registerCommands(prog, [new Command("presentation")]);

    expect(visibleCommandNames(prog)).toContain("presentation");
  });

  it("should hide unmapped commands and show capable ones with valid token", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual([
      "model",
      "model-provider",
      "agent",
      "upgrade",
      "resource",
      "whoami",
      "generate",
      "web",
    ]);
    expect(hiddenCommandNames(prog)).toEqual([
      "org",
      "connector",
      "mcp",
      "run",
      "credit",
      "chat",
      "schedule",
      "github",
      "slack",
      "feishu",
      "teams",
      "telegram",
      "phone",
      "browser",
      "host",
      "maps",
      "weather",
      "scrape",
      "people-search",
      "web-search",
      "social",
      "image-recognition",
      "finance",
      "seo",
      "banking",
    ]);
  });

  it("should hide run-only commands and keep global commands visible with malformed token", () => {
    vi.stubEnv("OKOU_TOKEN", "not-a-valid-token");

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toEqual([
      "mcp",
      "run",
      "image-recognition",
    ]);
    expect(registeredCommandNames(prog)).toContain("upgrade");
    expect(visibleCommandNames(prog)).toContain("browser");
  });

  it("should hide run-only commands and keep global commands visible outside the Okou run scope", () => {
    const token = buildOkouToken({
      scope: "sandbox",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toEqual([
      "mcp",
      "run",
      "image-recognition",
    ]);
    expect(registeredCommandNames(prog)).toContain("upgrade");
    expect(visibleCommandNames(prog)).toContain("browser");
  });

  it("should show current Run usage only with run-usage:read", () => {
    vi.stubEnv(
      "OKOU_TOKEN",
      buildOkouToken({ scope: "okou", capabilities: ["run-usage:read"] }),
    );

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("run");
    expect(visibleCommandNames(prog)).not.toContain("credit");
  });

  it("should show globally enabled commands when capabilities array is empty", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual([
      "model",
      "model-provider",
      "upgrade",
      "resource",
      "whoami",
      "generate",
      "web",
    ]);
  });

  it("should show scrape when scrape:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["scrape:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("scrape");
  });

  it("should show web-search when web-search:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["web-search:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("web-search");
  });

  it("should show social only with social:read capability", () => {
    const hiddenToken = buildOkouToken({
      scope: "okou",
      capabilities: ["web-search:read"],
    });
    vi.stubEnv("OKOU_TOKEN", hiddenToken);
    expect(hiddenCommandNames(buildProgram())).toContain("social");

    const visibleToken = buildOkouToken({
      scope: "okou",
      capabilities: ["social:read"],
    });
    vi.stubEnv("OKOU_TOKEN", visibleToken);
    expect(visibleCommandNames(buildProgram())).toContain("social");
  });

  it("should show finance when finance:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["finance:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("finance");
  });

  it("should show seo when seo:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["seo:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("seo");
  });

  it("should show people-search only with people-search:read capability", () => {
    const hiddenToken = buildOkouToken({
      scope: "okou",
      capabilities: ["web-search:read"],
    });
    vi.stubEnv("OKOU_TOKEN", hiddenToken);
    expect(hiddenCommandNames(buildProgram())).toContain("people-search");

    const visibleToken = buildOkouToken({
      scope: "okou",
      capabilities: ["people-search:read"],
    });
    vi.stubEnv("OKOU_TOKEN", visibleToken);
    expect(visibleCommandNames(buildProgram())).toContain("people-search");
  });

  it("should show credit with either billing read or billing write capability", () => {
    for (const capability of ["billing:read", "billing:write"]) {
      const token = buildOkouToken({
        scope: "okou",
        capabilities: [capability],
      });
      vi.stubEnv("OKOU_TOKEN", token);

      const prog = buildProgram();

      expect(visibleCommandNames(prog)).toContain("credit");
    }
  });

  it("should show model commands even without model-provider capabilities", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("model");
    expect(visibleCommandNames(prog)).toContain("model-provider");
  });

  it.each(["slack:read", "slack:write"])(
    "should show slack when %s capability is present",
    (capability) => {
      const token = buildOkouToken({
        scope: "okou",
        capabilities: [capability],
      });
      vi.stubEnv("OKOU_TOKEN", token);

      const prog = buildProgram();

      expect(visibleCommandNames(prog)).toContain("slack");
      expect(visibleCommandNames(prog)).toContain("whoami");
    },
  );

  it("should show feishu when feishu:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["feishu:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();
    expect(visibleCommandNames(prog)).toContain("feishu");
    expect(hiddenCommandNames(prog)).not.toContain("feishu");
  });

  it("should show github when github:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["github:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("github");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show github when github:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["github:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("github");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show chat when chat-thread:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["chat-thread:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("chat");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show chat when chat-thread:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["chat-thread:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("chat");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show chat when chat-event:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["chat-event:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("chat");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show chat when chat-event:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["chat-event:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("chat");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show telegram when telegram:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["telegram:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("telegram");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show telegram when telegram:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["telegram:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("telegram");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show phone when phone:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["phone:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("phone");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show phone when phone:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["phone:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("phone");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide telegram when only file:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should hide telegram when only file:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should show generate when file:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("generate");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show host when host:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["host:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("host");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show host when host:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["host:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("host");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show generate when file capabilities are missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("generate");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show maps when maps:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["maps:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("maps");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide maps when maps:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("maps");
  });

  it("should show weather when weather:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["weather:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("weather");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide weather when weather:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("weather");
  });

  it("should show banking when banking:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["banking:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("banking");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide banking when banking:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("banking");
  });

  it("should show credit when billing:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["billing:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("credit");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide credit but keep globally enabled upgrade guidance when billing capabilities are missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("credit");
    expect(registeredCommandNames(prog)).toContain("upgrade");
  });

  it("should show upgrade guidance", () => {
    vi.stubEnv("OKOU_TOKEN", undefined);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("upgrade");
    expect(buildHelpText()).toContain("Upgrade plan?");
  });

  it("should expose browser when its capability is enabled", () => {
    const enabledToken = buildOkouToken({
      scope: "okou",
      userId: "user-1",
      orgId: "org-1",
      capabilities: ["browser:read"],
    });
    vi.stubEnv("OKOU_TOKEN", enabledToken);

    expect(visibleCommandNames(buildProgram())).toContain("browser");
  });

  it("should expose canonical image recognition only to eligible Okou runs", () => {
    vi.stubEnv("OKOU_TOKEN", undefined);
    const noTokenProgram = buildProgram();
    expect(registeredCommandNames(noTokenProgram)).toContain(
      "image-recognition",
    );
    expect(hiddenCommandNames(noTokenProgram)).toContain("image-recognition");
    expect(buildHelpText()).not.toContain("Recognize an image?");

    const missingCapabilityToken = buildOkouToken({
      scope: "okou",
      userId: "user-1",
      orgId: "org-1",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", missingCapabilityToken);
    const missingCapabilityProgram = buildProgram();
    expect(hiddenCommandNames(missingCapabilityProgram)).toContain(
      "image-recognition",
    );
    expect(
      buildHelpText(decodeSandboxTokenPayload(missingCapabilityToken)),
    ).not.toContain("Recognize an image?");

    const eligibleToken = buildOkouToken({
      scope: "okou",
      userId: "user-1",
      orgId: "org-1",
      capabilities: ["image-recognition:write"],
    });
    vi.stubEnv("OKOU_TOKEN", eligibleToken);
    const eligibleProgram = buildProgram();
    expect(visibleCommandNames(eligibleProgram)).toContain("image-recognition");
    expect(buildHelpText(decodeSandboxTokenPayload(eligibleToken))).toContain(
      "Recognize an image?",
    );
    expect(buildHelpText(decodeSandboxTokenPayload(eligibleToken))).toContain(
      "okou image-recognition --file",
    );
  });

  it("should show billing help examples only for billing capabilities", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["billing:read", "billing:write"],
    });
    const help = buildHelpText(decodeSandboxTokenPayload(token));

    expect(help).toContain("Check credits?");
    expect(help).toContain("Buy credits?");
  });

  it("should show only credit status help for billing read capability", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["billing:read"],
    });
    const help = buildHelpText(decodeSandboxTokenPayload(token));

    expect(help).toContain("Check credits?");
    expect(help).toContain("okou credit");
    expect(help).not.toContain("Buy credits?");
    expect(help).toContain("Upgrade plan?");
  });

  it("should show only credit purchase help for billing write capability", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["billing:write"],
    });
    const help = buildHelpText(decodeSandboxTokenPayload(token));

    expect(help).not.toContain("Check credits?");
    expect(help).toContain("Buy credits?");
  });

  it("should hide billing help examples when billing capabilities are missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    const help = buildHelpText(decodeSandboxTokenPayload(token));

    expect(help).not.toContain("Check credits?");
    expect(help).not.toContain("Buy credits?");
  });

  it("should show the maps help example when maps:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["maps:read"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Get directions?",
    );
  });

  it("should hide the maps help example when maps:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Get directions?",
    );
  });

  it("should show the weather help example when weather:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["weather:read"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Check weather?",
    );
  });

  it("should hide the weather help example when weather:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Check weather?",
    );
  });

  it("should show the scrape help example when scrape:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["scrape:read"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Scrape a web page?",
    );
  });

  it("should hide the scrape help example when scrape:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Scrape a web page?",
    );
  });

  it("should show the finance help example when finance:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["finance:read"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Get a market quote?",
    );
  });

  it("should hide the finance help example when finance:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Get a market quote?",
    );
  });

  it("should gate the SEO help example on seo:read", () => {
    const visibleToken = buildOkouToken({
      scope: "okou",
      capabilities: ["seo:read"],
    });
    const hiddenToken = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(visibleToken))).toContain(
      "Research SEO data?",
    );
    expect(buildHelpText(decodeSandboxTokenPayload(hiddenToken))).not.toContain(
      "Research SEO data?",
    );
  });

  it("should show the people-search help example when people-search:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["people-search:read"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Find a professional?",
    );
  });

  it("should hide the people-search help example when people-search:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Find a professional?",
    );
  });

  it("should gate the social help example on social:read", () => {
    const visibleToken = buildOkouToken({
      scope: "okou",
      capabilities: ["social:read"],
    });
    const hiddenToken = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(visibleToken))).toContain(
      "Analyze social data?",
    );
    expect(buildHelpText(decodeSandboxTokenPayload(hiddenToken))).not.toContain(
      "Analyze social data?",
    );
  });

  it("should show the banking help example when banking:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["banking:read"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Read bank data?",
    );
  });

  it("should hide the banking help example when banking:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Read bank data?",
    );
  });

  it("should show the host help example when host:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["host:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Host a static site?",
    );
  });

  it("should show the hosted site clone help example when host:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["host:read"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Clone hosted site?",
    );
    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Host a static site?",
    );
  });

  it("should show the website help example", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: [],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Generate website?",
    );
  });

  it("should hide host when host:write capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("host");
  });

  it("should hide the host help example when host:write capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Host a static site?",
    );
    expect(buildHelpText(decodeSandboxTokenPayload(token))).not.toContain(
      "Clone hosted site?",
    );
  });

  it("should show the model help example in sandbox help", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: [],
    });

    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "List models?",
    );
    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Model routing?",
    );
  });

  it("should hide telegram when file read and telegram write capabilities are missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("teams");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should show teams when teams:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["teams:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("teams");
    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Send Teams?",
    );
    expect(buildHelpText(decodeSandboxTokenPayload(token))).toContain(
      "Download Teams?",
    );
  });

  it("should hide agent when agent:read capability is missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["connector:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual([
      "model",
      "model-provider",
      "connector",
      "mcp",
      "upgrade",
      "resource",
      "whoami",
      "generate",
      "web",
    ]);
    expect(hiddenCommandNames(prog)).toContain("agent");
  });

  it("should show connector when connector:read capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["connector:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("connector");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show run-only mcp only with connector:read capability", () => {
    const readToken = buildOkouToken({
      scope: "okou",
      capabilities: ["connector:read"],
    });
    vi.stubEnv("OKOU_TOKEN", readToken);
    expect(visibleCommandNames(buildProgram())).toContain("mcp");

    const writeToken = buildOkouToken({
      scope: "okou",
      capabilities: ["connector:write"],
    });
    vi.stubEnv("OKOU_TOKEN", writeToken);
    expect(hiddenCommandNames(buildProgram())).toContain("mcp");

    vi.stubEnv("OKOU_TOKEN", undefined);
    expect(hiddenCommandNames(buildProgram())).toContain("mcp");
  });

  it("should show connector when connector:write capability is present", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["connector:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    expect(visibleCommandNames(buildProgram())).toContain("connector");
  });

  it("should hide connector when connector capabilities are missing", () => {
    const token = buildOkouToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("connector");
  });
});

describe("okou generate command visibility", () => {
  it("should show website generation", () => {
    expect(visibleCommandNames(generateCommand)).toContain("website");
  });

  it("should show source-backed artifact generation", () => {
    expect(visibleCommandNames(generateCommand)).toEqual(
      expect.arrayContaining([
        "report",
        "docs-design",
        "poster",
        "dashboard-design",
        "mobile-app-design",
      ]),
    );
  });
});

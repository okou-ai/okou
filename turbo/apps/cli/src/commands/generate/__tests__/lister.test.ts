import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";
import {
  catalogItem,
  catalogStatusItem,
  manualAuthMethod,
  stubConnectorCatalog,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import {
  stubRunConnectorAccountInspection,
  writeRunConnectorAccountContext,
} from "../../__tests__/helpers/run-connector-accounts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_CONNECTION_ID = "00000000-0000-4000-8000-000000000001";

const CONNECTOR_LABELS: Record<string, string> = {
  elevenlabs: "ElevenLabs",
  fal: "fal.ai",
  hume: "Hume",
  joggai: "JoggAI",
  "luma-ai": "Luma AI",
  minimax: "MiniMax",
  openai: "OpenAI",
  replicate: "Replicate",
  runway: "Runway",
};

const CONNECTOR_GENERATION: Record<string, readonly string[]> = {
  elevenlabs: ["audio"],
  fal: ["image", "video"],
  hume: ["audio"],
  joggai: ["video"],
  "luma-ai": ["image", "video"],
  minimax: ["audio"],
  openai: ["audio", "image", "text"],
  replicate: ["image", "video"],
  runway: ["image", "video"],
};

interface TestConnectorAccount {
  readonly id: string;
  readonly slug: string;
  readonly authMethod: "api-token";
  readonly externalId: string;
  readonly externalUsername: string | null;
  readonly externalEmail: null;
  readonly oauthScopes: null;
  readonly connectionStatus: "connected" | "reconnect-required";
  readonly createdAt: string;
  readonly updatedAt: string;
}

function connector(
  connectorSlug: string,
  externalUsername: string | null = `${connectorSlug}-user`,
): TestConnectorAccount {
  return {
    id: RUN_CONNECTION_ID,
    slug: connectorSlug,
    authMethod: "api-token",
    externalId: `${connectorSlug}-external-id`,
    externalUsername,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function stubConnectors(connectors: readonly TestConnectorAccount[]) {
  return stubConnectorsWithCatalogSlugs(connectors, [
    "fal",
    "luma",
    "luma-ai",
    "openai",
    "replicate",
    "runway",
  ]);
}

function stubConnectorsWithCatalogSlugs(
  connectors: readonly TestConnectorAccount[],
  catalogConnectorSlugs: readonly string[],
) {
  const connectedBySlug = new Map(
    connectors.map((item) => {
      const connectorSlug = item.slug;
      return [
        connectorSlug,
        catalogStatusItem({
          connectorSlug,
          label: CONNECTOR_LABELS[connectorSlug] ?? connectorSlug,
          generation: [...(CONNECTOR_GENERATION[connectorSlug] ?? [])],
          authMethods: [manualAuthMethod()],
          connection: {
            authMethod: item.authMethod,
            externalUsername: item.externalUsername,
            externalEmail: item.externalEmail,
            reconnectReason: null,
          },
          connected: true,
          connectionStatus: item.connectionStatus,
        }),
      ] as const;
    }),
  );
  const visibleConnectorSlugs = new Set([
    ...catalogConnectorSlugs,
    ...connectedBySlug.keys(),
  ]);
  return stubConnectorCatalogStatus(
    [...visibleConnectorSlugs].map((connectorSlug) => {
      return (
        connectedBySlug.get(connectorSlug) ??
        catalogStatusItem({
          connectorSlug,
          label: CONNECTOR_LABELS[connectorSlug] ?? connectorSlug,
          generation: [...(CONNECTOR_GENERATION[connectorSlug] ?? [])],
          authMethods: [manualAuthMethod()],
        })
      );
    }),
  );
}

function stubRunConnectorsWithCatalogSlugs(
  contextPath: string,
  connectors: readonly TestConnectorAccount[],
  catalogConnectorSlugs: readonly string[],
) {
  const connectedBySlug = new Map(
    connectors.map((item) => {
      return [item.slug, item] as const;
    }),
  );
  const visibleConnectorSlugs = new Set([
    ...catalogConnectorSlugs,
    ...connectedBySlug.keys(),
  ]);
  writeRunConnectorAccountContext(
    contextPath,
    [...visibleConnectorSlugs].map((connectorSlug) => {
      return {
        kind: "builtin" as const,
        connectorSlug,
        connectionId: connectedBySlug.get(connectorSlug)?.id ?? null,
      };
    }),
  );
  return [
    stubConnectorCatalog(
      [...visibleConnectorSlugs].map((connectorSlug) => {
        return catalogItem({
          connectorSlug,
          label: CONNECTOR_LABELS[connectorSlug] ?? connectorSlug,
          generation: [...(CONNECTOR_GENERATION[connectorSlug] ?? [])],
          authMethods: [manualAuthMethod()],
        });
      }),
    ),
    stubRunConnectorAccountInspection(
      connectors.map((item) => {
        return {
          kind: "available" as const,
          connectionId: item.id,
          target: { kind: "builtin" as const, connectorSlug: item.slug },
          authMethod: item.authMethod,
          displayName: null,
          externalId: item.externalId,
          externalUsername: item.externalUsername,
          externalEmail: item.externalEmail,
          connectionStatus: item.connectionStatus,
          reconnectReason:
            item.connectionStatus === "reconnect-required"
              ? "authorization_expired_or_revoked"
              : null,
        };
      }),
    ),
  ] as const;
}

function stubRunConnectors(
  contextPath: string,
  connectors: readonly TestConnectorAccount[],
) {
  return stubRunConnectorsWithCatalogSlugs(contextPath, connectors, [
    "fal",
    "luma",
    "luma-ai",
    "openai",
    "replicate",
    "runway",
  ]);
}

function stubUserConnectors(enabledConnectorSlugs: string[]) {
  return http.get(
    `http://localhost:3000/api/agents/${AGENT_ID}/user-connectors`,
    () => {
      return HttpResponse.json({
        enabledConnectorSlugs: enabledConnectorSlugs,
      });
    },
  );
}

function stubBillingStatus(
  videoGenerationAllowed: boolean,
  tier = videoGenerationAllowed ? "pro" : "limited-free-1",
) {
  return http.get("http://localhost:3000/api/billing/status", () => {
    return HttpResponse.json({
      showUsagePack: false,
      tier,
      canBuyCredits: videoGenerationAllowed,
      videoGenerationAllowed,
      credits: 0,
      onboardingPaymentPending: false,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription:
        tier !== "free" && tier !== "limited-free-1" && tier !== "pro-suspend",
      autoRecharge: {
        enabled: false,
        threshold: null,
        amount: null,
      },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    });
  });
}

describe("okou generate lister", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  let directory = "";
  let contextPath = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "okou-generate-run-account-"));
    contextPath = join(directory, "context.json");
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", contextPath);
    server.use(stubBillingStatus(true));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  it("uses Okou branding in generate help", () => {
    let helpOutput = "";
    generateCommand.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    generateCommand.outputHelp();

    expect(helpOutput).toContain(
      "Generate assets via Okou's built-in pipelines",
    );
    expect(helpOutput).toContain(
      "--provider for Okou or connector execution guidance",
    );
  });

  it("lists ready image generation connectors for the current agent", async () => {
    let defaultStatusRequests = 0;
    server.use(
      ...stubRunConnectors(contextPath, [
        connector("fal", "fal-user"),
        connector("openai", "openai-user"),
        connector("replicate", "replicate-user"),
      ]),
      stubUserConnectors(["fal", "openai"]),
      http.get("http://localhost:3000/api/connector-catalog/status", () => {
        defaultStatusRequests += 1;
        return HttpResponse.json({
          connectors: [
            catalogStatusItem({
              connectorSlug: "fal",
              generation: ["image"],
              connection: {
                authMethod: "api-token",
                externalUsername: "default-account-a",
                externalEmail: null,
                reconnectReason: "authorization_expired_or_revoked",
              },
              connected: true,
              connectionStatus: "reconnect-required",
            }),
          ],
        });
      }),
    );

    await generateCommand.parseAsync(["node", "cli", "image"]);

    const text = output();
    expect(text).toContain("Image generation choices for current agent");
    expect(text).toContain(`Agent:    ${AGENT_ID}`);
    expect(text).toContain("Connectors:");
    expect(text).toContain("fal");
    expect(text).toContain("fal.ai");
    expect(text).toContain("@fal-user");
    expect(text).toContain("openai");
    expect(text).toContain("OpenAI");
    expect(text).not.toContain("replicate-user");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Okou  Built-in image generation");
    expect(text).toContain("Built-in image generation");
    expect(text).toContain(
      "Models: OpenAI: gpt-image-2.5-flare, gpt-image-2.5-sunburst; fal.ai: gpt-image-1 (default), gpt-image-2, flux-2-pro, ideogram-4, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, qwen-image-3, seedream4, nano-banana-2, nano-banana-2-lite; BytePlus: seedream5-pro, seedream5-lite",
    );
    expect(text).toContain("Use: okou generate image --provider built-in -h");
    expect(text).not.toContain(
      "Use: okou generate image --provider built-in --model",
    );
    expect(text).not.toContain("Model: gpt-image-2");
    expect(text).not.toContain("Model: fal-ai/flux-pro/v1.1");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
    expect(text).not.toContain("Next actions:");
    expect(text).not.toContain("default-account-a");
    expect(defaultStatusRequests).toBe(0);
    expect(text).toContain(
      "Use --all to see every image generation candidate.",
    );
  });

  it("shows not-ready candidates and action links with --all", async () => {
    let defaultStatusRequests = 0;
    server.use(
      ...stubRunConnectors(contextPath, [
        connector("fal", "fal-user"),
        connector("replicate", "replicate-user"),
        {
          ...connector("openai", "openai-user"),
          connectionStatus: "reconnect-required",
        },
      ]),
      stubUserConnectors(["fal"]),
      http.get("http://localhost:3000/api/connector-catalog/status", () => {
        defaultStatusRequests += 1;
        return HttpResponse.json({
          connectors: [
            catalogStatusItem({
              connectorSlug: "openai",
              generation: ["image"],
              connection: {
                authMethod: "api-token",
                externalUsername: "healthy-default-a",
                externalEmail: null,
                reconnectReason: null,
              },
              connected: true,
              connectionStatus: "connected",
            }),
          ],
        });
      }),
    );

    await generateCommand.parseAsync(["node", "cli", "image", "--all"]);

    const text = output();
    expect(text).toContain("Other image generation connectors");
    expect(text).toContain("Connectors:");
    expect(text).toContain("Replicate");
    expect(text).toContain("connected, not authorized for current agent");
    expect(text).toContain("Luma AI");
    expect(text).toContain("not admitted for this run");
    expect(text).toContain("OpenAI");
    expect(text).toContain("connected, reconnect required");
    expect(text).toContain(
      `[Authorize Replicate](http://localhost:3000/connectors/replicate/authorize?agentId=${AGENT_ID})`,
    );
    expect(text).not.toContain("Connect and authorize Luma AI");
    expect(text).toContain(
      `[Reconnect OpenAI](http://localhost:3000/connectors/openai/reconnect/${RUN_CONNECTION_ID}?agentId=${AGENT_ID})`,
    );
    expect(text).toContain("start a new run");
    expect(text).not.toContain("healthy-default-a");
    expect(defaultStatusRequests).toBe(0);
  });

  it("preserves default-account generation discovery outside a run", async () => {
    vi.stubEnv("OKOU_AGENT_ID", "");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
    server.use(stubConnectors([connector("fal", "default-account-a")]));

    await generateCommand.parseAsync(["node", "cli", "image"]);

    expect(output()).toContain("@default-account-a");
  });

  it("fails closed when connector-backed discovery has no run projection", async () => {
    let defaultStatusRequests = 0;
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
    server.use(
      stubConnectorCatalog([
        catalogItem({
          connectorSlug: "fal",
          label: "fal.ai",
          generation: ["image"],
          authMethods: [manualAuthMethod()],
        }),
      ]),
      stubUserConnectors(["fal"]),
      http.get("http://localhost:3000/api/connector-catalog/status", () => {
        defaultStatusRequests += 1;
        return HttpResponse.json({ connectors: [] });
      }),
    );

    await generateCommand.parseAsync(["node", "cli", "image", "--all"]);

    expect(output()).toContain("run account context unavailable");
    expect(output()).toContain("start a new run");
    expect(defaultStatusRequests).toBe(0);
  });

  it("does not list providers that are absent from the public catalog", async () => {
    server.use(
      ...stubRunConnectorsWithCatalogSlugs(contextPath, [], []),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", "text", "--all"]);

    const text = output();
    expect(text).toContain("No ready text generation connectors found.");
    expect(text).not.toContain("bentoml");
    expect(text).not.toContain("/connectors/bentoml");
  });

  it("prints connector guidance from the public catalog when --provider supports the generation type", async () => {
    server.use(
      stubConnectorCatalog([
        catalogItem({
          connectorSlug: "replicate",
          label: "Replicate",
          generation: ["image"],
          authMethods: [manualAuthMethod()],
        }),
      ]),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--provider",
      "replicate",
    ]);

    const text = output();
    expect(text).toContain(
      'Replicate (replicate) handles image generation through its own connector skill, not through "okou generate".',
    );
    expect(text).toContain('Use the "replicate" skill in this session.');
    expect(text).toContain("okou connector status replicate");
    expect(text).not.toContain("Built-in command:");
  });

  it("uses the public catalog when --provider names a connector that does not advertise the generation type", async () => {
    server.use(
      stubConnectorCatalog([
        catalogItem({
          connectorSlug: "elevenlabs",
          label: "ElevenLabs",
          generation: ["audio"],
          authMethods: [manualAuthMethod()],
        }),
      ]),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--provider",
      "elevenlabs",
    ]);

    const text = output();
    expect(text).toContain(
      "ElevenLabs (elevenlabs) does not advertise image generation.",
    );
    expect(text).toContain(
      'Run "okou generate image" to see every provider that supports this generation type.',
    );
  });

  it("suggests the built-in video command when no video connector is ready", async () => {
    server.use(
      ...stubRunConnectorsWithCatalogSlugs(
        contextPath,
        [],
        ["fal", "luma-ai", "runway"],
      ),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", "video"]);

    const text = output();
    expect(text).toContain("Video generation choices for current agent");
    expect(text).not.toContain("Connectors:");
    expect(text).not.toContain("No ready video generation connectors found.");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in video generation");
    // Spelled out rather than derived from the catalog, so moving the default
    // has to be a deliberate edit here instead of silently rewriting the help.
    expect(text).toContain(
      "Models: dreamina-seedance-2.5, dreamina-seedance-2.0 (default), dreamina-seedance-2.0-fast, dreamina-seedance-2.0-mini, seedance-1.5-pro, veo3.1-fast, kling-v3-4k, minimax-h3",
    );
    expect(text).toContain("Use: okou generate video --provider built-in -h");
    expect(text).toContain(
      "Availability: Available on the current plan without connector setup.",
    );
    expect(text).not.toContain(
      "Use: okou generate video --provider built-in --model",
    );
    expect(text).not.toContain("Model: dreamina-seedance-2-0-260128");
    expect(text).not.toContain("Model: seedance-1-5-pro-251215");
    expect(text).not.toContain("Model: seedance-1-0-pro-250528");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
    expect(text).not.toContain("Next actions:");
    expect(text).not.toContain(
      "Use --all to see every video generation candidate.",
    );
  });

  it("reflects built-in and connector choices for avatar video", async () => {
    server.use(
      ...stubRunConnectorsWithCatalogSlugs(
        contextPath,
        [connector("joggai", "jogg-user")],
        ["joggai"],
      ),
      stubUserConnectors(["joggai"]),
    );

    await generateCommand.parseAsync(["node", "cli", "avatar-video"]);

    const text = output();
    expect(text).toContain(
      "Talking-avatar video generation choices for current agent",
    );
    expect(text).toContain("joggai");
    expect(text).toContain("JoggAI");
    expect(text).toContain("@jogg-user");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in JoggAI talking-avatar video generation");
    expect(text).toContain("Models: joggai-talking-avatar");
    expect(text).toContain(
      "Use: okou generate avatar-video --provider built-in -h",
    );
    expect(text).toContain(
      "Availability: Available on the current plan without connector setup.",
    );
  });

  it("marks built-in video models as plan-restricted before generation", async () => {
    server.use(
      ...stubRunConnectorsWithCatalogSlugs(
        contextPath,
        [],
        ["fal", "luma-ai", "runway"],
      ),
      stubUserConnectors([]),
      stubBillingStatus(false),
    );

    await generateCommand.parseAsync(["node", "cli", "video"]);

    const text = output();
    expect(text).toContain(
      "Availability: Requires a Pro, Team, or Custom workspace plan.",
    );
    expect(text).toContain(
      "[Compare plans](http://localhost:3000/?settings=billing&billingView=plans)",
    );
  });

  it("suggests the built-in presentation command", async () => {
    server.use(stubConnectorsWithCatalogSlugs([], []), stubUserConnectors([]));

    await generateCommand.parseAsync(["node", "cli", "presentation"]);

    const text = output();
    expect(text).toContain("Presentation generation choices for current agent");
    expect(text).not.toContain("Connectors:");
    expect(text).not.toContain(
      "No ready presentation generation connectors found.",
    );
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in presentation generation");
    expect(text).toContain("Models: gpt-5.5");
    expect(text).toContain("Use: okou generate presentation -h");
    expect(text).not.toContain("Model: gpt-5.5");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
  });

  it("suggests the built-in website command", async () => {
    server.use(stubConnectorsWithCatalogSlugs([], []), stubUserConnectors([]));

    await generateCommand.parseAsync(["node", "cli", "website"]);

    const text = output();
    expect(text).toContain("Website generation choices for current agent");
    expect(text).not.toContain("Connectors:");
    expect(text).not.toContain("No ready website generation connectors found.");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in website generation");
    expect(text).toContain("Models: gpt-5.5");
    expect(text).toContain("Use: okou generate website -h");
    expect(text).toContain("Context:");
    expect(text).toContain(
      "Standalone static website artifacts can be authored locally and published with okou host for a hosted URL.",
    );
    expect(text).toContain(
      "okou host is for static directories with index.html; it is not a general deploy system for apps that need a backend, database, worker, or long-running process.",
    );
    expect(text).toContain(
      "Existing web app changes should usually follow the project's own build, test, and deploy workflow.",
    );
    expect(text).not.toContain("Model: gpt-5.5");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
  });

  it.each([
    ["report", "Report", "Built-in report generation"],
    ["docs-design", "Docs design", "Built-in docs design generation"],
    ["poster", "Poster", "Built-in poster generation"],
    [
      "dashboard-design",
      "Dashboard design",
      "Built-in dashboard design generation",
    ],
    [
      "mobile-app-design",
      "Mobile app design",
      "Built-in mobile app design generation",
    ],
  ])("suggests the built-in %s command", async (type, label, commandLabel) => {
    server.use(stubConnectorsWithCatalogSlugs([], []), stubUserConnectors([]));

    await generateCommand.parseAsync(["node", "cli", type]);

    const text = output();
    expect(text).toContain(`${label} generation choices for current agent`);
    expect(text).not.toContain(`No ready ${type} generation connectors found.`);
    expect(text).toContain("Built-in command:");
    expect(text).toContain(commandLabel);
    expect(text).toContain("Models: gpt-5.5");
    expect(text).toContain(`Use: okou generate ${type} -h`);
  });

  it("suggests the built-in voice command when no voice connector is ready", async () => {
    server.use(
      ...stubRunConnectorsWithCatalogSlugs(
        contextPath,
        [],
        ["elevenlabs", "hume", "minimax", "openai"],
      ),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", "voice"]);

    const text = output();
    expect(text).toContain("Voice generation choices for current agent");
    expect(text).not.toContain("Connectors:");
    expect(text).not.toContain("No ready voice generation connectors found.");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in voice generation");
    expect(text).toContain("Models: gpt-4o-mini-tts");
    expect(text).toContain("Use: okou generate voice --provider built-in -h");
    expect(text).not.toContain("Model: gpt-4o-mini-tts");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
    expect(text).not.toContain("Next actions:");
    expect(text).not.toContain(
      'okou generate voice --provider built-in --text "Hello"',
    );
  });

  it("also shows the built-in voice provider when a voice connector is ready", async () => {
    server.use(
      ...stubRunConnectorsWithCatalogSlugs(
        contextPath,
        [connector("openai", "openai-user")],
        ["elevenlabs", "hume", "minimax", "openai"],
      ),
      stubUserConnectors(["openai"]),
    );

    await generateCommand.parseAsync(["node", "cli", "voice"]);

    const text = output();
    expect(text).toContain("Voice generation choices for current agent");
    expect(text).toContain("Connectors:");
    expect(text).toContain("OpenAI");
    expect(text).toContain("@openai-user");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in voice generation");
    expect(text).toContain("Models: gpt-4o-mini-tts");
    expect(text).toContain("Use: okou generate voice --provider built-in -h");
    expect(text).not.toContain("Model: gpt-4o-mini-tts");
  });

  it("lists music as the public audio connector-backed subtype", async () => {
    server.use(
      ...stubRunConnectorsWithCatalogSlugs(
        contextPath,
        [connector("elevenlabs", "elevenlabs-user")],
        ["elevenlabs", "minimax"],
      ),
      stubUserConnectors(["elevenlabs"]),
    );

    await generateCommand.parseAsync(["node", "cli", "music"]);

    const text = output();
    expect(text).toContain("Music generation choices for current agent");
    expect(text).toContain("Connectors:");
    expect(text).toContain("ElevenLabs");
    expect(text).toContain("@elevenlabs-user");
    expect(text).not.toContain("Built-in command:");
  });

  it("uses Okou branding when a subtype has no built-in pipeline", async () => {
    const musicCommand = generateCommand.commands.find((command) => {
      return command.name() === "music";
    });
    let helpOutput = "";
    musicCommand?.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    musicCommand?.outputHelp();
    expect(helpOutput).toContain(
      "Okou does not provide a built-in music pipeline.",
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "music",
      "--provider",
      "built-in",
    ]);
    expect(output()).toContain(
      "Okou has no built-in music generation pipeline.",
    );
  });

  it("rejects unknown generation types via Commander", async () => {
    await expect(
      generateCommand.parseAsync(["node", "cli", "spaceship"]),
    ).rejects.toThrow();
    await expect(
      generateCommand.parseAsync(["node", "cli", "audio"]),
    ).rejects.toThrow();
  });
});

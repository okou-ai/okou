import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectorCheckRequestBodySchema,
  type ConnectorCheckRequestBody,
  type ConnectorCheckTargetAwareDiagnosticResult,
} from "@okouai/api-contracts/contracts/connector-check";
import type { ConnectorAccountInspectionResult } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorMcpResponseSchema } from "@okouai/api-contracts/contracts/custom-connectors";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import {
  connectorAccount,
  stubConnectorAccounts,
} from "../../__tests__/helpers/connector-accounts";
import {
  catalogItem,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import {
  stubRunConnectorAccountInspection,
  writeRunConnectorAccountContext,
} from "../../__tests__/helpers/run-connector-accounts";
import { checkConnectorCommand } from "../check";

const ORIGIN = "http://localhost:3000";
const CUSTOM_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const DEFAULT_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
const TARGET = { kind: "custom", customConnectorId: CUSTOM_ID } as const;
const REQUEST_URL = "https://api.acme.test/pinned/items";

type ResolvedUrl = Extract<
  ConnectorCheckTargetAwareDiagnosticResult,
  { outcome: "resolved"; mode: "url" }
>;
type AvailableAccount = Extract<
  ConnectorAccountInspectionResult,
  { kind: "available" }
>;

function resolvedCustom(permission?: ResolvedUrl["permission"]): ResolvedUrl {
  return {
    outcome: "resolved",
    mode: "url",
    connector: {
      target: TARGET,
      label: "Earlier display name",
      visibility: "available",
      credentialResolution: "network-boundary",
    },
    environmentNames: null,
    run: { status: "configured", bases: ["https://api.acme.test/pinned"] },
    method: "POST",
    base: "https://api.acme.test/pinned",
    relativePath: "/items",
    permission: permission ?? {
      kind: "matched",
      permissions: [
        {
          name: "items:write",
          policy: { outcome: "deny", basis: "deny-list" },
        },
      ],
    },
  };
}

function account(
  connectionStatus: AvailableAccount["connectionStatus"] = "connected",
): AvailableAccount {
  return {
    setupStatus: "complete",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    kind: "available",
    target: TARGET,
    connectionId: ACCOUNT_ID,
    authMethod: "manual",
    displayName: "Run-selected account",
    externalId: "selected-external-id",
    externalUsername: null,
    externalEmail: null,
    connectionStatus,
    reconnectReason:
      connectionStatus === "reconnect-required"
        ? "authorization_expired_or_revoked"
        : null,
  };
}

describe("custom connector URL diagnostics", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const requests: ConnectorCheckRequestBody[] = [];
  let directory = "";
  let contextPath = "";

  function stubDiagnostic(
    result: ConnectorCheckTargetAwareDiagnosticResult,
  ): void {
    server.use(
      http.post(
        `${ORIGIN}/api/connectors/diagnostics/check`,
        async ({ request }) => {
          requests.push(
            connectorCheckRequestBodySchema.parse(await request.json()),
          );
          return HttpResponse.json(result);
        },
      ),
    );
  }

  function output(): string {
    return log.mock.calls.flat().join("\n");
  }

  function stubCurrentMemberDiagnostic(): void {
    vi.stubEnv("OKOU_AGENT_ID", "");
    stubDiagnostic({
      ...resolvedCustom({
        kind: "unknown-endpoint",
        policy: { outcome: "unavailable", basis: "not-run-scoped" },
      }),
      run: { status: "not-scoped" },
    });
  }

  async function check(...extraArgs: string[]): Promise<void> {
    await checkConnectorCommand.parseAsync([
      "node",
      "okou",
      "--url",
      REQUEST_URL,
      "--method",
      "POST",
      ...extraArgs,
    ]);
  }

  beforeEach(() => {
    checkConnectorCommand.setOptionValue("json", false);
    requests.length = 0;
    directory = mkdtempSync(join(tmpdir(), "okou-custom-check-"));
    contextPath = join(directory, "accounts.json");
    vi.stubEnv("OKOU_API_BACKEND_URL", ORIGIN);
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_AGENT_ID", "agent-1");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-1");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", contextPath);
    writeRunConnectorAccountContext(contextPath, [
      { ...TARGET, connectionId: ACCOUNT_ID },
    ]);
    stubDiagnostic(resolvedCustom());
    server.use(
      stubAgentCustomConnectors([]),
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          customConnector({
            id: CUSTOM_ID,
            displayName: "Renamed Acme",
            slug: "_mutable-new-slug",
            prefixTemplates: ["https://api.acme.test/new-default"],
          }),
        );
      }),
      stubRunConnectorAccountInspection([
        account(),
        {
          ...account(),
          connectionId: DEFAULT_ACCOUNT_ID,
          displayName: "Default sibling",
        },
      ]),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    `custom:${CUSTOM_ID}`,
    CUSTOM_ID,
    "_mutable-new-slug",
    "Renamed Acme",
  ])(
    "emits the exact custom account, subtype, and grant state for %s as JSON",
    async (selector) => {
      server.use(
        stubCustomConnectors([
          customConnector({
            id: CUSTOM_ID,
            slug: "_mutable-new-slug",
            displayName: "Renamed Acme",
          }),
        ]),
      );
      await check("--connector", selector, "--json");
      const json: unknown = JSON.parse(output());
      expect(json).toMatchObject({
        context: "run",
        request: { target: TARGET },
        connector: {
          target: TARGET,
          label: "Renamed Acme",
          connectorType: "custom-http",
          definitionAvailable: true,
        },
        account: {
          state: "available",
          connectionId: ACCOUNT_ID,
          metadata: { connectionStatus: "connected" },
        },
        accountSummary: null,
        memberStatus: null,
        managedStatus: null,
        authorization: { authorized: false },
        diagnostic: {
          run: { bases: ["https://api.acme.test/pinned"] },
          permission: {
            permissions: [{ name: "items:write", policy: { outcome: "deny" } }],
          },
        },
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(output()).not.toMatch(
        /Default sibling|new-default|permission-request/,
      );
    },
  );

  it("reports unavailable definition metadata explicitly without replacing its account", async () => {
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 },
        );
      }),
    );
    await check("--json");
    const json: unknown = JSON.parse(output());
    expect(json).toMatchObject({
      connector: {
        target: TARGET,
        label: CUSTOM_ID,
        connectorType: null,
        definitionAvailable: false,
      },
      account: { connectionId: ACCOUNT_ID },
    });
  });

  it("uses the canonical current-member account summary outside a run", async () => {
    server.use(
      stubConnectorAccounts([
        connectorAccount(
          { kind: "custom", customConnectorId: CUSTOM_ID },
          {
            id: DEFAULT_ACCOUNT_ID,
            authMethod: "manual",
            displayName: "Current default",
            configuredFieldKeys: ["apiKey"],
          },
        ),
      ]),
    );
    stubCurrentMemberDiagnostic();
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(customConnector({}));
      }),
    );
    await check();
    expect(output()).toContain("Current account status: connected.");
    expect(output()).toContain("Current default account: Current default");
    expect(output()).toContain(`Default connection ID: ${DEFAULT_ACCOUNT_ID}`);
    expect(output()).toContain("Setup status: complete");
    expect(output()).not.toContain(ACCOUNT_ID);

    log.mockClear();
    await check("--json");
    const json: unknown = JSON.parse(output());
    expect(json).toMatchObject({
      context: "current",
      account: null,
      authorization: null,
      accountSummary: {
        accountCount: 1,
        defaultConnection: { id: DEFAULT_ACCOUNT_ID, setupStatus: "complete" },
      },
      memberStatus: "connected",
      managedStatus: null,
      diagnostic: { run: { status: "not-scoped" } },
    });
    expect(output()).not.toContain(ACCOUNT_ID);
  });

  it.each([
    { scenario: "empty", status: "not-connected", text: "not connected" },
    {
      scenario: "missing-default",
      status: "default-required",
      text: "default account required",
    },
    {
      scenario: "unavailable",
      status: "unavailable",
      text: "account status unavailable",
    },
    {
      scenario: "reconnect",
      status: "reconnect-required",
      text: "reconnect needed",
    },
    {
      scenario: "incomplete",
      status: "setup-required",
      text: "missing apiKey",
    },
    {
      scenario: "invalid",
      status: "reconnect-required",
      text: "reconnect needed",
    },
  ] as const)(
    "explains $scenario current-member accounts in text and JSON",
    async ({ scenario, status, text }) => {
      stubCurrentMemberDiagnostic();
      const currentAccount = connectorAccount(TARGET, {
        id: DEFAULT_ACCOUNT_ID,
        authMethod: "manual",
        displayName: "Current default",
        configuredFieldKeys: scenario === "incomplete" ? [] : ["apiKey"],
        isDefault: scenario !== "missing-default",
        connectionStatus:
          scenario === "reconnect" || scenario === "invalid"
            ? "reconnect-required"
            : "connected",
        setupStatus:
          scenario === "invalid"
            ? "invalid"
            : scenario === "incomplete"
              ? "incomplete"
              : "complete",
        missingRequiredFields: scenario === "incomplete" ? ["apiKey"] : [],
      });
      server.use(
        scenario === "unavailable"
          ? http.get(`${ORIGIN}/api/connector-accounts/connections`, () => {
              return HttpResponse.json(
                { error: { code: "NOT_FOUND", message: "Unavailable" } },
                { status: 404 },
              );
            })
          : stubConnectorAccounts(scenario === "empty" ? [] : [currentAccount]),
      );

      await check();
      expect(output()).toContain(`Current account status: ${text}.`);
      expect(output()).toContain(
        "[Connectors](http://localhost:3000/connectors)",
      );
      const hasDefault =
        scenario !== "empty" &&
        scenario !== "unavailable" &&
        scenario !== "missing-default";
      if (hasDefault) {
        expect(output()).toContain(
          `Default connection ID: ${DEFAULT_ACCOUNT_ID}`,
        );
        expect(output()).toContain(
          `Setup status: ${currentAccount.setupStatus}`,
        );
      }
      if (scenario === "incomplete") {
        expect(output()).toContain("Missing required configuration: apiKey");
      }

      log.mockClear();
      await check("--json");
      expect(JSON.parse(output())).toMatchObject({
        context: "current",
        account: null,
        memberStatus: status,
        accountSummary:
          scenario === "empty" || scenario === "unavailable"
            ? null
            : {
                accountCount: 1,
                defaultConnection: hasDefault
                  ? {
                      id: DEFAULT_ACCOUNT_ID,
                      setupStatus: currentAccount.setupStatus,
                    }
                  : null,
              },
      });
    },
  );

  it("reports a removed current-member definition and account inventory as unavailable", async () => {
    stubCurrentMemberDiagnostic();
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 },
        );
      }),
      http.get(`${ORIGIN}/api/connector-accounts/connections`, () => {
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 },
        );
      }),
    );
    await check();
    expect(output()).toContain(
      "Current custom connector metadata is unavailable or deleted.",
    );
    expect(output()).toContain(
      "Current account status: account status unavailable.",
    );
    expect(output()).toContain(
      "[Connectors](http://localhost:3000/connectors)",
    );

    log.mockClear();
    await check("--json");
    expect(JSON.parse(output())).toMatchObject({
      context: "current",
      connector: { definitionAvailable: false },
      account: null,
      accountSummary: null,
      memberStatus: "unavailable",
    });
  });

  it("surfaces failed current-member inventory reads as command errors", async () => {
    stubCurrentMemberDiagnostic();
    server.use(
      http.get(`${ORIGIN}/api/connector-accounts/connections`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Inventory failed",
            },
          },
          { status: 500 },
        );
      }),
    );
    await expect(check()).rejects.toThrow("process.exit called");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "500: Inventory failed",
    );
  });

  it.each([
    { runBound: false, connected: true },
    { runBound: false, connected: false },
    { runBound: true, connected: true },
    { runBound: true, connected: false },
  ])(
    "keeps managed business status separate from member and Run accounts ($runBound, $connected)",
    async ({ runBound, connected }) => {
      const managedStatus = {
        connected,
        ...(connected
          ? {
              connectedAccountId: DEFAULT_ACCOUNT_ID,
              connectedAccountUpdatedAt: "2026-10-21T00:00:00.000Z",
            }
          : {}),
        missingRequiredFields: connected ? [] : ["clientSecret"],
        configuredFieldKeys: connected ? ["clientSecret"] : [],
      };
      const managed = customConnector({
        id: CUSTOM_ID,
        authMode: "oauth",
        ...managedStatus,
        oauthConfig: {
          providerAdapter: "feishu",
          clientId: "managed-client-must-not-appear",
          authorizationUrl: "https://auth.example.test/authorize",
          tokenUrl: "https://auth.example.test/token",
          tokenEndpointAuthMethod: "client_secret_post",
          pkceMethod: "S256",
          scopes: [],
          authorizationParams: {},
        },
      });
      server.use(
        http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
          return HttpResponse.json(managed);
        }),
      );
      if (!runBound) {
        stubCurrentMemberDiagnostic();
      }
      await check();
      if (runBound) {
        expect(output()).toContain(`Connection ID: ${ACCOUNT_ID}`);
        expect(output()).toContain(
          "The account selected for this run is connected.",
        );
      } else {
        expect(output()).toContain(
          `Current integration status: ${connected ? "connected" : "not connected"}.`,
        );
        if (connected) {
          expect(output()).toContain(
            `Integration connection ID: ${DEFAULT_ACCOUNT_ID}`,
          );
        } else {
          expect(output()).toContain(
            "Missing required configuration: clientSecret",
          );
          expect(output()).toContain(
            "[Connectors](http://localhost:3000/connectors)",
          );
        }
      }
      expect(output()).not.toContain("managed-client-must-not-appear");

      log.mockClear();
      await check("--json");
      const json: unknown = JSON.parse(output());
      expect(json).toMatchObject({
        context: runBound ? "run" : "current",
        account: runBound ? { connectionId: ACCOUNT_ID } : null,
        accountSummary: null,
        memberStatus: null,
      });
      expect(json).toHaveProperty(
        "managedStatus",
        runBound ? null : managedStatus,
      );
      expect(output()).not.toContain("managed-client-must-not-appear");
    },
  );

  it("keeps unavailable run context separate from current custom connection metadata", async () => {
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
    await check("--json");
    const json: unknown = JSON.parse(output());
    expect(json).toMatchObject({
      context: "run",
      accountSummary: null,
      memberStatus: null,
      managedStatus: null,
      account: { state: "context-unavailable", reason: "legacy-or-missing" },
    });
    expect(output()).not.toContain(DEFAULT_ACCOUNT_ID);
  });

  it("retains custom unknown-endpoint remediation without inventing a permission request", async () => {
    stubDiagnostic(
      resolvedCustom({
        kind: "unknown-endpoint",
        policy: { outcome: "ask", basis: "unknown-policy" },
      }),
    );
    await check("--json");
    const json: unknown = JSON.parse(output());
    expect(json).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({
          kind: "link",
          guidance: expect.stringContaining(
            "There is no custom unknown-endpoint approval control",
          ),
        }),
      ]),
    });
    expect(output()).not.toContain("permission-request");
  });

  it("retains target-unavailable reasons and the exact custom target in JSON", async () => {
    stubDiagnostic({
      outcome: "target-unavailable",
      target: TARGET,
      reason: "not-admitted",
    });
    await check("--json");
    const json: unknown = JSON.parse(output());
    expect(json).toMatchObject({
      diagnostic: {
        outcome: "target-unavailable",
        target: TARGET,
        reason: "not-admitted",
      },
      message: expect.stringContaining("was not admitted"),
    });
    expect(process.exitCode).toBe(1);
  });

  it("selects a stable UUID and displays current metadata with the pinned account and bases", async () => {
    await check("--connector", `custom:${CUSTOM_ID}`);

    expect(requests).toStrictEqual([
      { mode: "url", method: "POST", url: REQUEST_URL, target: TARGET },
    ]);
    expect(output()).toContain(
      `Renamed Acme connector (custom UUID: ${CUSTOM_ID})`,
    );
    expect(output()).toContain(`Connection ID: ${ACCOUNT_ID}`);
    expect(output()).toContain("Run-selected account");
    expect(output()).toContain(
      "The account selected for this run is connected.",
    );
    expect(output()).toContain("https://api.acme.test/pinned");
    expect(output()).toContain("Environment names: unavailable");
    expect(output()).toContain("current intended state");
    expect(output()).toContain('"items:write" is in the deny list');
    expect(output()).toContain(
      "[Connectors](http://localhost:3000/connectors)",
    );
    expect(output()).toContain("review Permissions");
    expect(output()).toContain(`--connector 'custom:${CUSTOM_ID}'`);
    expect(output()).not.toMatch(
      /Earlier display name|Default sibling|new-default|secrets\.apiKey|Bearer|_mutable-new-slug/,
    );
    expect(output()).not.toMatch(
      /permission-request|connectorSlug=|callback-prompt|connected, active, and authorized/,
    );
  });

  it.each(["incomplete", "invalid"] as const)(
    "explains %s setup on the admitted custom account in text and JSON",
    async (setupStatus) => {
      const connectionStatus =
        setupStatus === "invalid" ? "reconnect-required" : "connected";
      server.use(
        stubAgentCustomConnectors([
          { customConnectorId: CUSTOM_ID, permissionNames: ["items:write"] },
        ]),
        stubConnectorAccounts([
          connectorAccount(TARGET, {
            id: DEFAULT_ACCOUNT_ID,
            authMethod: "manual",
            displayName: "Default sibling",
            configuredFieldKeys: ["apiKey"],
          }),
        ]),
        stubRunConnectorAccountInspection([
          {
            ...account(connectionStatus),
            setupStatus,
            reconnectReason: null,
            missingRequiredFields: ["apiKey"],
          },
          {
            ...account(),
            connectionId: DEFAULT_ACCOUNT_ID,
            displayName: "Default sibling",
          },
        ]),
      );
      await check("--connector", `custom:${CUSTOM_ID}`);
      expect(output()).toContain(`Connection ID: ${ACCOUNT_ID}`);
      expect(output()).toContain(`Setup status: ${setupStatus}`);
      expect(output()).toContain("Missing required configuration: apiKey");
      expect(output()).toContain(
        "[Connectors](http://localhost:3000/connectors)",
      );
      expect(output()).not.toMatch(
        /Default sibling|account selected for this run is connected/,
      );

      log.mockClear();
      await check("--connector", `custom:${CUSTOM_ID}`, "--json");
      const json: unknown = JSON.parse(output());
      expect(json).toMatchObject({
        account: {
          connectionId: ACCOUNT_ID,
          metadata: { connectionStatus, setupStatus },
        },
        authorization: { authorized: true },
        actions: expect.arrayContaining([
          expect.objectContaining({
            kind: "link",
            label: "Review Renamed Acme accounts and agent access",
            supportsCallback: false,
          }),
        ]),
      });
      expect(output()).not.toContain(DEFAULT_ACCOUNT_ID);
    },
  );

  it("does not substitute a healthy default for a reconnect-required run account", async () => {
    server.use(
      stubRunConnectorAccountInspection([
        {
          ...account("reconnect-required"),
          setupStatus: "incomplete",
          missingRequiredFields: ["apiKey"],
        },
      ]),
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          customConnector({
            id: CUSTOM_ID,
          }),
        );
      }),
    );
    await check();

    expect(requests).toStrictEqual([
      {
        mode: "url",
        method: "POST",
        url: REQUEST_URL,
        includeCustomConnectors: true,
      },
    ]);
    expect(output()).toContain(`Connection ID: ${ACCOUNT_ID}`);
    expect(output()).toContain(
      "account selected for this run needs to be reconnected",
    );
    expect(output()).not.toContain(
      "account selected for this run is connected",
    );
  });

  it.each([
    ["http", "slug"],
    ["http", "uuid"],
    ["http", "qualified"],
    ["http", "name"],
    ["mcp", "slug"],
    ["mcp", "uuid"],
    ["mcp", "qualified"],
    ["mcp", "name"],
  ] as const)(
    "resolves a custom %s %s and preserves the run-pinned target",
    async (kind, form) => {
      const httpDefinition = customConnector({
        id: CUSTOM_ID,
        slug: `_acme-${kind}`,
        displayName: "Current custom connector",
      });
      const definition =
        kind === "http"
          ? httpDefinition
          : customConnectorMcpResponseSchema.parse({
              ...httpDefinition,
              kind: "mcp",
              transport: "streamable-http",
              endpoint: "https://api.acme.test/mcp",
              prefixTemplates: [],
              permissionBundleRef: null,
            });
      server.use(
        stubCustomConnectors([definition]),
        http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
          return HttpResponse.json(definition);
        }),
      );

      const selectors = {
        slug: definition.slug,
        uuid: CUSTOM_ID,
        qualified: `custom:${definition.slug}`,
        name: definition.displayName,
      };
      await check("--connector", selectors[form]);

      expect(requests).toStrictEqual([
        { mode: "url", method: "POST", url: REQUEST_URL, target: TARGET },
      ]);
      expect(output()).toContain(`custom UUID: ${CUSTOM_ID}`);
      expect(output()).toContain(`Connection ID: ${ACCOUNT_ID}`);
      expect(output()).toContain("Run-selected account");
      expect(output()).toContain("https://api.acme.test/pinned");
      expect(output()).toContain("review Permissions");
      expect(output()).not.toMatch(
        /Default sibling|permission-request|connectorSlug=/,
      );
    },
  );

  it("does not infer run admission from a connected org-visible slug", async () => {
    const definition = customConnector({
      id: CUSTOM_ID,
    });
    server.use(stubCustomConnectors([definition]));
    stubDiagnostic({
      outcome: "target-unavailable",
      target: TARGET,
      reason: "not-admitted",
    });

    await expect(check("--connector", definition.slug)).rejects.toThrow(
      "process.exit called",
    );

    expect(requests).toStrictEqual([
      { mode: "url", method: "POST", url: REQUEST_URL, target: TARGET },
    ]);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "was not admitted to this run",
    );
    expect(output()).toBe("");
  });

  it.each(["unknown", "ambiguous"])(
    "rejects an %s custom slug before diagnosis",
    async (scenario) => {
      server.use(
        stubCustomConnectors(
          scenario === "unknown"
            ? []
            : [
                customConnector({ id: CUSTOM_ID }),
                customConnector({ id: DEFAULT_ACCOUNT_ID }),
              ],
        ),
      );

      await expect(check("--connector", "_acme-search")).rejects.toThrow(
        "process.exit called",
      );

      expect(requests).toStrictEqual([]);
      const message = error.mock.calls.flat().join("\n");
      expect(message).toContain(
        scenario === "unknown"
          ? "Unknown or unavailable connector selector"
          : "Ambiguous connector selector",
      );
      if (scenario === "ambiguous") {
        expect(message).toContain(`custom:${CUSTOM_ID}`);
        expect(message).toContain(`custom:${DEFAULT_ACCOUNT_ID}`);
      } else {
        expect(message).toContain("okou connector list");
      }
    },
  );

  it("propagates failed slug discovery without trying another diagnostic target", async () => {
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Inventory lookup failed",
            },
          },
          { status: 500 },
        );
      }),
    );

    await expect(check("--connector", "_acme-search")).rejects.toThrow(
      "process.exit called",
    );

    expect(requests).toStrictEqual([]);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "Failed to list custom connectors (HTTP 500)",
    );
    expect(error.mock.calls.flat().join("\n")).not.toContain(
      "Inventory lookup failed",
    );
    expect(error.mock.calls.flat().join("\n")).not.toContain(
      "Unknown or unavailable custom connector selector",
    );
  });

  it("rejects embedded URL credentials before resolving a custom slug", async () => {
    await expect(
      checkConnectorCommand.parseAsync([
        "node",
        "okou",
        "--url",
        "https://user:password@api.acme.test/items",
        "--connector",
        "_acme-search",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requests).toStrictEqual([]);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "valid absolute http or https URL",
    );
    expect(error.mock.calls.flat().join("\n")).not.toContain("password");
  });

  it("retains a deleted pinned account identity without suggesting a sibling account", async () => {
    server.use(stubRunConnectorAccountInspection([]));
    await check();
    expect(output()).toContain(`Account used by this run: ${ACCOUNT_ID}`);
    expect(output()).toContain(
      "Current account metadata is unavailable or deleted",
    );
    expect(output()).not.toMatch(
      /Default sibling|\/connectors\/[^\s]+\/connect|is connected/,
    );
  });

  it("does not infer an account when run account context is missing", async () => {
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
    await check();
    expect(output()).toContain("started without connector account context");
    expect(output()).not.toContain("is connected");
  });

  it("reports a definition removed after diagnosis without reusing its stale display name", async () => {
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
    );
    await check();
    expect(output()).toContain(`custom UUID: ${CUSTOM_ID}`);
    expect(output()).toContain(
      "Current custom connector metadata is unavailable or deleted",
    );
    expect(output()).not.toContain("Earlier display name");
  });

  it("propagates metadata read failures rather than reporting the connector as deleted", async () => {
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          { error: { message: "Metadata failed", code: "INTERNAL" } },
          { status: 500 },
        );
      }),
    );
    await expect(check()).rejects.toThrow("process.exit called");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "Failed to get custom connector (HTTP 500)",
    );
    expect(error.mock.calls.flat().join("\n")).not.toContain("Metadata failed");
    expect(output()).not.toContain("unavailable or deleted");
  });

  it.each([
    { reason: "not-admitted", expected: "was not admitted to this run" },
    { reason: "connector-unavailable", expected: "is unavailable" },
    {
      reason: "permission-bundle-unavailable",
      expected: "unavailable permission metadata",
    },
    {
      reason: "runtime-configuration-unavailable",
      expected: "unavailable runtime configuration",
    },
  ] as const)(
    "explains $reason from backend authority",
    async ({ reason, expected }) => {
      stubDiagnostic({ outcome: "target-unavailable", target: TARGET, reason });
      await expect(check("--connector", `custom:${CUSTOM_ID}`)).rejects.toThrow(
        "process.exit called",
      );
      expect(error.mock.calls.flat().join("\n")).toContain(expected);
      expect(error.mock.calls.flat().join("\n")).toContain(
        `custom:${CUSTOM_ID}`,
      );
      expect(output()).toBe("");
    },
  );

  it("keeps builtin and custom overlapping owners distinct in deterministic selection commands", async () => {
    stubDiagnostic({
      outcome: "ambiguous",
      candidates: [
        { target: TARGET, label: "GitHub" },
        {
          target: { kind: "builtin", connectorSlug: "github" },
          label: "GitHub",
        },
      ],
    });
    await expect(check()).rejects.toThrow("process.exit called");
    const message = error.mock.calls.flat().join("\n");
    expect(message).toContain(`custom:${CUSTOM_ID}, github`);
    expect(message).toContain(
      `--connector 'custom:${CUSTOM_ID}' --method 'POST'`,
    );
    expect(message).toContain("--connector 'github' --method 'POST'");
    expect(message).not.toContain("connectorSlug=");
  });

  it("resolves a unique builtin name beginning with an underscore", async () => {
    server.use(
      stubConnectorCatalog([
        catalogItem({ connectorSlug: "server-only", label: "_service-name" }),
      ]),
      stubCustomConnectors([]),
    );
    stubDiagnostic({ outcome: "unknown-connector" });
    await expect(check("--connector", "_service-name")).rejects.toThrow(
      "process.exit called",
    );
    expect(requests).toStrictEqual([
      {
        mode: "url",
        method: "POST",
        url: REQUEST_URL,
        connectorSlug: "server-only",
      },
    ]);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "Unknown connector slug: server-only",
    );
  });

  it("rejects an underscore-prefixed name shared by builtin and custom connectors", async () => {
    server.use(
      stubConnectorCatalog([
        catalogItem({ connectorSlug: "server-only", label: "_service-name" }),
      ]),
      stubCustomConnectors([customConnector({ displayName: "_service-name" })]),
    );
    await expect(check("--connector", "_service-name")).rejects.toThrow(
      "process.exit called",
    );
    expect(requests).toStrictEqual([]);
    const message = error.mock.calls.flat().join("\n");
    expect(message).toContain("Ambiguous connector selector");
    expect(message).toContain("builtin:server-only");
    expect(message).toContain(`custom:${CUSTOM_ID}`);
  });

  it("rejects a UUID shared by a builtin slug and custom ID before diagnosis", async () => {
    server.use(
      stubConnectorCatalog([
        catalogItem({ connectorSlug: CUSTOM_ID, label: "UUID builtin" }),
      ]),
      stubCustomConnectors([customConnector()]),
    );
    await expect(check("--connector", CUSTOM_ID)).rejects.toThrow(
      "process.exit called",
    );
    expect(requests).toStrictEqual([]);
    const message = error.mock.calls.flat().join("\n");
    expect(message).toContain("Ambiguous connector selector");
    expect(message).toContain(`builtin:${CUSTOM_ID}`);
    expect(message).toContain(`custom:${CUSTOM_ID}`);
  });

  it.each([CUSTOM_ID, `builtin:${CUSTOM_ID}`])(
    "diagnoses a UUID-shaped builtin slug selected by %s",
    async (selector) => {
      server.use(
        stubConnectorCatalog([catalogItem({ connectorSlug: CUSTOM_ID })]),
        stubCustomConnectors([]),
      );
      stubDiagnostic({ outcome: "unknown-connector" });
      await expect(check("--connector", selector)).rejects.toThrow(
        "process.exit called",
      );
      expect(requests).toStrictEqual([
        {
          mode: "url",
          method: "POST",
          url: REQUEST_URL,
          connectorSlug: CUSTOM_ID,
        },
      ]);
      expect(error.mock.calls.flat().join("\n")).toContain(
        `Unknown connector slug: ${CUSTOM_ID}`,
      );
    },
  );

  it("rejects an unavailable qualified name before sending a diagnostic", async () => {
    server.use(stubCustomConnectors([]));
    await expect(check("--connector", "custom:missing-name")).rejects.toThrow(
      "process.exit called",
    );
    expect(requests).toStrictEqual([]);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "Unknown or unavailable custom connector selector",
    );
  });

  it("does not treat custom unknown endpoints as a grantable builtin permission", async () => {
    stubDiagnostic(
      resolvedCustom({
        kind: "unknown-endpoint",
        policy: { outcome: "ask", basis: "unknown-policy" },
      }),
    );
    await check();
    expect(output()).toContain("unknown endpoint policy requires approval");
    expect(output()).toContain(
      "There is no custom unknown-endpoint approval control",
    );
    expect(output()).not.toMatch(
      /permission-request|connectorSlug=|review Permissions/,
    );
  });

  it("rejects a legacy identity in a target-aware response without retrying", async () => {
    server.use(
      http.post(
        `${ORIGIN}/api/connectors/diagnostics/check`,
        async ({ request }) => {
          requests.push(
            connectorCheckRequestBodySchema.parse(await request.json()),
          );
          return HttpResponse.json({
            ...resolvedCustom(),
            connector: {
              connectorSlug: "github",
              label: "GitHub",
              visibility: "available",
              credentialResolution: "network-boundary",
            },
          });
        },
      ),
    );
    await expect(check()).rejects.toThrow("process.exit called");
    expect(requests).toHaveLength(1);
    expect(output()).toBe("");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

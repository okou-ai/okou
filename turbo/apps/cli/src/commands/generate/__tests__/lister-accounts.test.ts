import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import {
  connectorAccount,
  connectorAccountSummary,
  stubConnectorAccountSummaries,
} from "../../__tests__/helpers/connector-accounts";
import {
  catalogStatusItem,
  catalogStatusMetadata,
  manualAuthMethod,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import { generateCommand } from "../index";

const target = { kind: "builtin", connectorSlug: "fal" } as const;
const metadata = catalogStatusMetadata({
  connectorSlug: "fal",
  label: "fal.ai",
  generation: ["image"],
  authMethods: [manualAuthMethod()],
});

describe("generation current-member accounts", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("command exited");
  });

  function output(): string {
    return log.mock.calls.flat().join("\n");
  }
  function install(accounts: readonly ConnectorAccountConnection[]): void {
    server.use(
      stubConnectorCatalogStatus([metadata]),
      stubConnectorAccountSummaries([
        connectorAccountSummary(target, accounts),
      ]),
    );
  }

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_AGENT_ID", "");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
  });
  afterEach(() => {
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
  });

  it("lists the saved default with no catalog account projections and batches account reads", async () => {
    const account = connectorAccount(target, {
      authMethod: "api-token",
      displayName: "Work",
      externalUsername: "canonical",
    });
    const accounts = [
      account,
      connectorAccount(target, {
        isDefault: false,
        connectionStatus: "reconnect-required",
        externalUsername: "sibling",
      }),
    ];
    install(accounts);
    let requests = 0;
    server.use(
      http.get(
        "http://localhost:3000/api/connector-accounts",
        ({ request }) => {
          requests += 1;
          expect(
            new URL(request.url).searchParams.get("includeScopeMismatch"),
          ).toBe("true");
          return HttpResponse.json({
            summaries: [connectorAccountSummary(target, accounts)],
          });
        },
      ),
    );
    await generateCommand.parseAsync(["node", "okou", "image", "--all"]);
    expect(output()).toContain("Work (@canonical)");
    expect(output()).not.toContain("sibling");
    expect(output()).not.toContain("Other image generation connectors");
    expect(requests).toBe(1);
  });

  it("keeps canonical false scope and ready credentials authoritative over conflicting catalog state", async () => {
    const account = connectorAccount(target, {
      id: "00000000-0000-4000-8000-000000000001",
      authMethod: "api-token",
      externalUsername: "canonical",
      scopeMismatch: false,
    });
    install([account]);
    server.use(
      stubConnectorCatalogStatus([
        catalogStatusItem({
          connectorSlug: "fal",
          label: "fal.ai",
          generation: ["image"],
          scopeMismatch: true,
          connected: false,
          connectionStatus: "reconnect-required",
          connection: {
            id: account.id,
            authMethod: "api-token",
            externalUsername: "stale",
            externalEmail: null,
            reconnectReason: "authorization_expired_or_revoked",
          },
        }),
      ]),
    );
    await generateCommand.parseAsync(["node", "okou", "image", "--all"]);
    expect(output()).toContain("@canonical");
    expect(output()).not.toContain("stale");
    expect(output()).not.toContain("Next actions:");
  });

  it("requires reconnect when canonical credentials fail despite a healthy catalog projection", async () => {
    const account = connectorAccount(target, {
      connectionStatus: "reconnect-required",
      externalUsername: "canonical",
    });
    install([account]);
    server.use(
      stubConnectorCatalogStatus([
        catalogStatusItem({
          connectorSlug: "fal",
          label: "fal.ai",
          generation: ["image"],
          connected: true,
          connectionStatus: "connected",
          connection: {
            id: account.id,
            authMethod: account.authMethod,
            externalUsername: "stale",
            externalEmail: null,
            reconnectReason: null,
          },
        }),
      ]),
    );
    await generateCommand.parseAsync(["node", "okou", "image", "--all"]);
    expect(output()).toContain("connected, reconnect required");
    expect(output()).toContain(
      "[Reconnect fal.ai](http://localhost:3000/connectors)",
    );
    expect(output()).not.toContain("stale");
  });

  it.each([
    {
      name: "reconnect",
      changes: { connectionStatus: "reconnect-required" as const },
      reason: "reconnect required",
      action: "Reconnect fal.ai",
      path: "/connectors",
    },
    {
      name: "incomplete setup",
      changes: {
        setupStatus: "incomplete" as const,
        missingRequiredFields: ["apiKey"],
      },
      reason: "missing apiKey",
      action: "Manage fal.ai accounts",
      path: "/connectors",
    },
    {
      name: "invalid setup",
      changes: { setupStatus: "invalid" as const },
      reason: "setup invalid",
      action: "Manage fal.ai accounts",
      path: "/connectors",
    },
    {
      name: "unknown setup",
      changes: { setupStatus: undefined },
      reason: "account review required",
      action: "Manage fal.ai accounts",
      path: "/connectors",
    },
    {
      name: "unknown scope",
      changes: { scopeMismatch: undefined },
      reason: "account review required",
      action: "Manage fal.ai accounts",
      path: "/connectors",
    },
    {
      name: "scope update",
      changes: { scopeMismatch: true },
      reason: "permissions update required",
      action: "Update fal.ai permissions",
      path: "/connectors/fal/connect",
    },
  ])(
    "guides $name from canonical account facts",
    async ({ changes, reason, action, path }) => {
      install([connectorAccount(target, changes)]);
      await generateCommand.parseAsync(["node", "okou", "image", "--all"]);
      expect(output()).toContain(reason);
      expect(output()).toContain(`[${action}](http://localhost:3000${path})`);
    },
  );

  it("requires a default rather than offering a new connection for existing accounts", async () => {
    install([
      connectorAccount(target, { isDefault: false }),
      connectorAccount(target, { isDefault: false }),
    ]);
    await generateCommand.parseAsync(["node", "okou", "image", "--all"]);
    expect(output()).toContain("default account required");
    expect(output()).toContain(
      "[Manage fal.ai accounts](http://localhost:3000/connectors)",
    );
  });

  it("offers a connection when no saved account exists", async () => {
    install([]);
    await generateCommand.parseAsync(["node", "okou", "image", "--all"]);
    expect(output()).toContain(
      "[Connect fal.ai](http://localhost:3000/connectors/fal/connect)",
    );
  });

  it("fails visibly when saved accounts cannot be read", async () => {
    install([connectorAccount(target)]);
    server.use(
      http.get("http://localhost:3000/api/connector-accounts", () => {
        return HttpResponse.json(
          {
            error: {
              code: "UNAVAILABLE",
              message: "Account metadata unavailable",
            },
          },
          { status: 503 },
        );
      }),
    );
    await expect(
      generateCommand.parseAsync(["node", "okou", "image", "--all"]),
    ).rejects.toThrow("command exited");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "Account metadata unavailable",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["image", "presentation"])(
    "does not need account summaries for %s without connector candidates",
    async (type) => {
      install([]);
      server.use(
        stubConnectorCatalogStatus([]),
        http.get("http://localhost:3000/api/connector-accounts", () => {
          throw new Error("No account request is needed");
        }),
      );
      await generateCommand.parseAsync(["node", "okou", type]);
      expect(output()).toContain("Built-in command:");
    },
  );
});

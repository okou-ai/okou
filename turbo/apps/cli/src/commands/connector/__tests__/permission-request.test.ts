/**
 * Tests for okou connector permission-request command.
 *
 * The command only points users at the grant page after a URL diagnostic
 * confirms that the requested Okou permission is denied or requires approval.
 */

import {
  connectorCheckRequestSchema,
  type ConnectorCheckDiagnosticResult,
  type ConnectorCheckPolicy,
} from "@okouai/api-contracts/contracts/connector-check";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import {
  catalogItem,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { permissionRequestCommand } from "../permission-request";

const SLACK_READ_PERMISSION = "admin.conversations:read";
const SLACK_READ_URL = "https://slack.com/api/admin.conversations.search";

type ResolvedUrlDiagnostic = Extract<
  ConnectorCheckDiagnosticResult,
  { readonly outcome: "resolved"; readonly mode: "url" }
>;

interface NonRequestablePolicyCase {
  readonly name: string;
  readonly policy: ConnectorCheckPolicy;
  readonly expected: string;
}

function permissionActionUrl(output: string): URL {
  const href = output.match(/\[Manage [^\]]+ permissions\]\(([^)]+)\)/)?.[1];
  if (!href) {
    throw new Error("Expected permission action URL");
  }
  return new URL(href);
}

function resolvedUrlDiagnostic(
  args: {
    readonly connectorSlug?: string;
    readonly label?: string;
    readonly method?: string;
    readonly base?: string;
    readonly relativePath?: string;
    readonly permission?: ResolvedUrlDiagnostic["permission"];
    readonly run?: ResolvedUrlDiagnostic["run"];
  } = {},
): ResolvedUrlDiagnostic {
  return {
    outcome: "resolved",
    mode: "url",
    connector: {
      connectorSlug: args.connectorSlug ?? "slack",
      label: args.label ?? "Slack",
      visibility: "available",
      credentialResolution: "network-boundary",
    },
    environmentNames: ["SLACK_TOKEN"],
    run: args.run ?? {
      status: "configured",
      bases: [args.base ?? "https://slack.com/api"],
    },
    method: args.method ?? "GET",
    base: args.base ?? "https://slack.com/api",
    relativePath: args.relativePath ?? "/admin.conversations.search",
    permission: args.permission ?? {
      kind: "matched",
      permissions: [
        {
          name: SLACK_READ_PERMISSION,
          policy: { outcome: "deny", basis: "deny-list" },
        },
      ],
    },
  };
}

function stubDiagnostic(
  result: ConnectorCheckDiagnosticResult,
  baseUrl = "https://app.okou.ai",
  onRequest?: (
    request: ReturnType<typeof connectorCheckRequestSchema.parse>,
  ) => void,
): void {
  if (result.outcome === "unknown-connector") {
    server.use(
      stubConnectorCatalog(
        [catalogItem({ connectorSlug: "unknown-service" })],
        baseUrl,
      ),
    );
  }
  if ("connector" in result) {
    server.use(stubConnectorCatalog([catalogItem(result.connector)], baseUrl));
  }
  server.use(
    http.post(
      `${baseUrl}/api/connectors/diagnostics/check`,
      async ({ request }) => {
        const body: unknown = await request.json();
        const parsed = connectorCheckRequestSchema.parse(body);
        onRequest?.(parsed);
        return HttpResponse.json(result);
      },
    ),
  );
}

describe("okou connector permission-request command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    const result = resolvedUrlDiagnostic();
    stubDiagnostic(result, "https://app.okou.ai");
    stubDiagnostic(result, "https://www.okou.ai");
    stubDiagnostic(result, "https://api.okou.ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it.each([
    "custom:33333333-3333-4333-8333-333333333333",
    "33333333-3333-4333-8333-333333333333",
    "_acme-search",
    "custom:_acme-search",
    "Acme Search",
  ])(
    "resolves custom selector %s to settings guidance without builtin approval",
    async (selector) => {
      const customId = "33333333-3333-4333-8333-333333333333";
      vi.stubEnv("OKOU_AGENT_ID", "agent-1");
      vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-1");
      server.use(
        stubCustomConnectors([customConnector()], "https://app.okou.ai"),
      );
      let diagnosticCalls = 0;
      stubDiagnostic(resolvedUrlDiagnostic(), "https://app.okou.ai", () => {
        diagnosticCalls += 1;
      });

      await expect(
        permissionRequestCommand.parseAsync([
          "node",
          "okou",
          selector,
          "--permission",
          "items:write",
          "--url",
          "https://api.acme.test/items",
          "--callback-prompt",
          "Continue after approval",
        ]),
      ).rejects.toThrow("process.exit called");

      const message = mockConsoleError.mock.calls.flat().join("\n");
      expect(message).toContain(customId);
      expect(message).toContain("[Connectors](https://app.okou.ai/connectors)");
      expect(message).toContain("review Permissions");
      expect(message).not.toMatch(
        /connectorSlug=|action=allow|callbackPrompt=/,
      );
      expect(mockConsoleLog).not.toHaveBeenCalled();
      expect(diagnosticCalls).toBe(0);
      expect(mockExit).toHaveBeenCalledWith(1);
    },
  );

  it("outputs an allow grant link without choosing the user's duration", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
    let diagnosticRequest:
      | ReturnType<typeof connectorCheckRequestSchema.parse>
      | undefined;
    stubDiagnostic(
      resolvedUrlDiagnostic(),
      "https://app.okou.ai",
      (request) => {
        diagnosticRequest = request;
      },
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--url",
      `${SLACK_READ_URL}?token=secret#fragment`,
    ]);

    expect(diagnosticRequest).toStrictEqual({
      mode: "url",
      method: "GET",
      url: SLACK_READ_URL,
      connectorSlug: "slack",
    });
    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      `You can allow the "${SLACK_READ_PERMISSION}" permission for your connector access`,
    );
    expect(logCalls).toContain("[Manage Slack permissions]");
    expect(logCalls).toContain("/agents/agent-abc-123/permissions?");
    expect(logCalls).toContain("connectorSlug=slack");
    expect(logCalls).toContain(
      `permission=${encodeURIComponent(SLACK_READ_PERMISSION)}`,
    );
    expect(logCalls).toContain("action=allow");
    expect(logCalls).not.toContain("expiresIn=");
    expect(logCalls).not.toContain("Requested duration:");
    expect(logCalls).not.toContain("admin approval");
    expect(logCalls).not.toContain("secret");
  });

  it("preserves explicit AWS selectors while checking the requested permission", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
    let diagnosticRequest:
      | ReturnType<typeof connectorCheckRequestSchema.parse>
      | undefined;
    stubDiagnostic(
      resolvedUrlDiagnostic({
        connectorSlug: "aws",
        label: "AWS",
        method: "POST",
        base: "https://sts.us-west-2.amazonaws.com",
        relativePath: "/",
        permission: {
          kind: "matched",
          permissions: [
            {
              name: "sts:get-caller-identity",
              policy: { outcome: "deny", basis: "deny-list" },
            },
          ],
        },
      }),
      "https://app.okou.ai",
      (request) => {
        diagnosticRequest = request;
      },
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "aws",
      "--permission",
      "sts:get-caller-identity",
      "--url",
      "https://sts.us-west-2.amazonaws.com/",
      "--method",
      "POST",
      "--aws-service",
      "sts",
      "--aws-action",
      "GetCallerIdentity",
    ]);

    expect(diagnosticRequest).toStrictEqual({
      mode: "url",
      method: "POST",
      url: "https://sts.us-west-2.amazonaws.com/",
      connectorSlug: "aws",
      aws: { sigv4Service: "sts", action: "GetCallerIdentity" },
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      "no SigV4 signature was validated and no AWS request was sent",
    );
    expect(output).toContain("[Manage AWS permissions]");
  });

  it("includes the current thread and callback prompt in the grant URL", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-abc-123");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--url",
      SLACK_READ_URL,
      "--callback-prompt",
      "Re-check permission & continue",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(
      Array.from(permissionActionUrl(logCalls).searchParams.entries()),
    ).toStrictEqual([
      ["connectorSlug", "slack"],
      ["permission", SLACK_READ_PERMISSION],
      ["action", "allow"],
      ["threadId", "thread-abc-123"],
      ["callbackPrompt", "Re-check permission & continue"],
    ]);
    expect(logCalls).toContain("end the current turn");
    expect(logCalls).toContain("exact callback URL above verbatim");
    expect(logCalls).toContain("omitting any query parameters");
    expect(logCalls).not.toContain("expiresIn=");
  });

  it.each(["a", "继", "😀"])(
    "accepts a trimmed callback prompt of exactly 200 characters (%s)",
    async (character) => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
      vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-abc-123");
      const callbackPrompt = character.repeat(200);

      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
        "--url",
        SLACK_READ_URL,
        "--callback-prompt",
        `  ${callbackPrompt}\n`,
      ]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(
        permissionActionUrl(output).searchParams.get("callbackPrompt"),
      ).toBe(callbackPrompt);
      expect(mockConsoleError).not.toHaveBeenCalled();
    },
  );

  it.each(["a", "继", "😀"])(
    "rejects a callback prompt over 200 characters with shortening guidance (%s)",
    async (character) => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
      vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-abc-123");
      const callbackPrompt = character.repeat(201);

      await expect(
        permissionRequestCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--permission",
          SLACK_READ_PERMISSION,
          "--url",
          SLACK_READ_URL,
          "--callback-prompt",
          callbackPrompt,
        ]),
      ).rejects.toThrow("process.exit called");

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain("--callback-prompt is too long");
      expect(errorOutput).toContain("concise and within 200 characters");
      expect(errorOutput).toContain(
        "long URLs that are difficult to recognize",
      );
      expect(errorOutput).not.toContain(callbackPrompt);
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
        "[Manage",
      );
    },
  );

  it("rejects callback prompts outside the current web chat", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
        "--url",
        SLACK_READ_URL,
        "--callback-prompt",
        "Continue",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--callback-prompt can only target the current web chat thread and agent",
      ),
    );
  });

  it("rejects callback prompts for a different agent", async () => {
    vi.stubEnv("OKOU_AGENT_ID", "agent-current");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-abc-123");

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
        "--url",
        SLACK_READ_URL,
        "--agent",
        "agent-other",
        "--callback-prompt",
        "Continue",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--agent agent-other conflicts with the current run's Agent agent-current",
      ),
    );
  });

  it("outputs an allow grant link for unknown endpoints", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
    const unknownUrl = "https://api.cloudflare.com/client/v4/example";
    stubDiagnostic(
      resolvedUrlDiagnostic({
        connectorSlug: "cloudflare",
        label: "Cloudflare",
        base: "https://api.cloudflare.com/client/v4",
        relativePath: "/example",
        permission: {
          kind: "unknown-endpoint",
          policy: { outcome: "deny", basis: "unknown-policy" },
        },
      }),
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "cloudflare",
      "--permission",
      UNKNOWN_PERMISSION_GRANT,
      "--url",
      unknownUrl,
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "You can allow unknown endpoints for your connector access",
    );
    expect(logCalls).toContain("[Manage Cloudflare permissions]");
    expect(logCalls).toContain("connectorSlug=cloudflare");
    expect(logCalls).toContain("permission=__unknown__");
    expect(logCalls).toContain("action=allow");
    expect(logCalls).not.toContain("expiresIn=");
  });

  it("uses the agents landing page when OKOU_AGENT_ID is not set", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--url",
      SLACK_READ_URL,
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents?");
    expect(logCalls).not.toContain("/agents/permissions");
  });

  it("uses --agent when OKOU_AGENT_ID is not set", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--url",
      SLACK_READ_URL,
      "--agent",
      "target-agent-123",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents/target-agent-123/permissions?");
    expect(logCalls).toContain("connectorSlug=slack");
    expect(logCalls).toContain("action=allow");
  });

  it("accepts --agent when it matches the current run's Agent", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "target-agent-123");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--url",
      SLACK_READ_URL,
      "--agent",
      "target-agent-123",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents/target-agent-123/permissions?");
  });

  it("transforms www.okou.ai to app.okou.ai", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://www.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "agent-1");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--url",
      SLACK_READ_URL,
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "https://app.okou.ai/agents/agent-1/permissions?",
    );
  });

  it("prints sensitive Slack user-token guidance for chat:write enable", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
    const url = "https://slack.com/api/chat.postMessage";
    stubDiagnostic(
      resolvedUrlDiagnostic({
        method: "POST",
        relativePath: "/chat.postMessage",
        permission: {
          kind: "matched",
          permissions: [
            {
              name: "chat:write",
              policy: { outcome: "deny", basis: "deny-list" },
            },
          ],
        },
      }),
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      "chat:write",
      "--url",
      url,
      "--method",
      "POST",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("AS THE USER's identity");
    expect(logCalls).toContain("okou slack message send");
    expect(logCalls).toContain("Only allow this permission below");
  });

  it("prints sensitive Gmail sending guidance for messages.send enable", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_AGENT_ID", "agent-abc-123");
    const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
    stubDiagnostic(
      resolvedUrlDiagnostic({
        connectorSlug: "gmail",
        label: "Gmail",
        method: "POST",
        base: "https://gmail.googleapis.com",
        relativePath: "/gmail/v1/users/me/messages/send",
        permission: {
          kind: "matched",
          permissions: [
            {
              name: "messages.send",
              policy: { outcome: "ask", basis: "ask-list" },
            },
          ],
        },
      }),
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "gmail",
      "--permission",
      "messages.send",
      "--url",
      url,
      "--method",
      "POST",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("send emails directly as the user");
    expect(logCalls).toContain("drafts.write");
    expect(logCalls).toContain("Only allow this permission below");
  });

  it.each([
    ["server-only", "Server Only"],
    ["builtin:server-only", "Server Only"],
    ["Server Only", "Server Only"],
    ["builtin:Server Only", "Server Only"],
    ["serveronly", "serveronly"],
    ["builtin:serveronly", "serveronly"],
  ])(
    "validates server-authored selector %s absent from the CLI bundle",
    async (selector, label) => {
      vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
      server.use(stubCustomConnectors([], "https://app.okou.ai"));
      const url = "https://api.server-only.example/v1/records";
      stubDiagnostic(
        resolvedUrlDiagnostic({
          connectorSlug: "server-only",
          label,
          base: "https://api.server-only.example",
          relativePath: "/v1/records",
          permission: {
            kind: "matched",
            permissions: [
              {
                name: "records.read",
                policy: { outcome: "deny", basis: "deny-list" },
              },
            ],
          },
        }),
      );

      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        selector,
        "--permission",
        "records.read",
        "--url",
        url,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`[Manage ${label} permissions]`);
      expect(logCalls).toContain("connectorSlug=server-only");
      expect(logCalls).toContain("permission=records.read");
    },
  );

  it("rejects embedded credentials before resolving a custom display name", async () => {
    let inventoryRequests = 0;
    server.use(
      http.get("https://app.okou.ai/api/custom-connectors", () => {
        inventoryRequests += 1;
        return HttpResponse.json({ connectors: [customConnector()] });
      }),
    );
    await expect(
      permissionRequestCommand.parseAsync([
        "node",
        "okou",
        "Acme Search",
        "--permission",
        "items:write",
        "--url",
        "https://user:secret-password@api.acme.test/items",
      ]),
    ).rejects.toThrow("process.exit called");
    const output = mockConsoleError.mock.calls.flat().join("\n");
    expect(output).toContain("valid absolute http or https URL");
    expect(output).not.toContain("secret-password");
    expect(inventoryRequests).toBe(0);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("exits with an error for an unknown connector slug", async () => {
    stubDiagnostic({ outcome: "unknown-connector" });
    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "builtin:unknown-service",
        "--permission",
        "foo",
        "--url",
        "https://unknown.example/v1",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Unknown connector slug: unknown-service"),
    );
  });

  it("exits with authentication guidance when no token is available", async () => {
    vi.stubEnv("OKOU_TOKEN", "");
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
        "--url",
        SLACK_READ_URL,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
    );
  });

  it("requires a failed request URL for regular connectors", async () => {
    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--url is required"),
    );
    expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
      "[Manage",
    );
  });

  it("rejects provider scopes that do not match the checked route", async () => {
    const routeUrl = "https://slack.com/api/conversations.history";
    stubDiagnostic(
      resolvedUrlDiagnostic({
        relativePath: "/conversations.history",
        permission: {
          kind: "matched",
          permissions: [
            {
              name: "conversations:history",
              policy: { outcome: "deny", basis: "deny-list" },
            },
          ],
        },
      }),
    );

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "im:history",
        "--url",
        `${routeUrl}?oldest=secret`,
      ]);
    }).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain(
      `Permission "im:history" does not match GET ${routeUrl}`,
    );
    expect(errorOutput).toContain("maps to: conversations:history");
    expect(errorOutput).toContain("missing_scope/needed");
    expect(errorOutput).not.toContain("secret");
    expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
      "[Manage",
    );
  });

  it.each([
    {
      name: "already allowed",
      policy: { outcome: "allow", basis: "allow-list" },
      expected: "is already allowed by Okou",
    },
    {
      name: "unavailable",
      policy: { outcome: "unavailable", basis: "not-run-scoped" },
      expected: "Retry okou connector check from an active run",
    },
  ] satisfies readonly NonRequestablePolicyCase[])(
    "does not create a grant when policy is $name",
    async ({ policy, expected }) => {
      stubDiagnostic(
        resolvedUrlDiagnostic({
          run:
            policy.outcome === "unavailable"
              ? { status: "not-scoped" }
              : undefined,
          permission: {
            kind: "matched",
            permissions: [{ name: SLACK_READ_PERMISSION, policy }],
          },
        }),
      );

      await expect(async () => {
        await permissionRequestCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--permission",
          SLACK_READ_PERMISSION,
          "--url",
          SLACK_READ_URL,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(expected),
      );
      expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
        "[Manage",
      );
    },
  );

  it("explains selected-host token grants for computer-use permission changes", async () => {
    vi.stubEnv("OKOU_TOKEN", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "computer-use",
      "--permission",
      "computer-use:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Computer Use access is not managed as a connector permission.",
    );
    expect(logCalls).toContain(
      "issued only when an Okou Desktop Computer Use host is selected for the chat or thread",
    );
    expect(logCalls).toContain("Open Okou Desktop");
    expect(logCalls).toContain("Existing run tokens cannot be upgraded");
    expect(logCalls).toContain("okou whoami");
    expect(logCalls).not.toContain("[Manage");
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("outputs a delegated authorization link for computer-use enable when authenticated", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "run-token");

    server.use(
      http.post(
        "http://localhost:3000/api/computer-use/authorization-requests",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe("Bearer run-token");
          return HttpResponse.json({
            authorizationUrl:
              "https://app.okou.ai/computer-use/authorize/vm0_computer_use_authorization_request_test",
            source: "chat",
            expiresAt: "2026-06-24T13:00:00.000Z",
          });
        },
      ),
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "computer-use",
      "--permission",
      "computer-use:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Computer Use needs an Okou Desktop host selected before a run starts.",
    );
    expect(logCalls).toContain(
      "https://app.okou.ai/computer-use/authorize/vm0_computer_use_authorization_request_test",
    );
    expect(logCalls).toContain("This link expires at 2026-06-24T13:00:00.000Z");
    expect(logCalls).not.toContain(
      "Computer Use authorization link unavailable",
    );
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("recognizes computer-use:write even when the connector slug is wrong", async () => {
    vi.stubEnv("OKOU_TOKEN", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "agent",
      "--permission",
      "computer-use:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Computer Use access is not managed as a connector permission.",
    );
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("explains thread access for cloud browser permission changes", async () => {
    vi.stubEnv("OKOU_TOKEN", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "browser",
      "--permission",
      "browser:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Cloud browser access is controlled by the current chat thread",
    );
    expect(logCalls).toContain("under Your computer in the chat composer");
    expect(logCalls).toContain("Existing run tokens cannot be upgraded");
    expect(logCalls).not.toContain("[Manage");
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("outputs a delegated authorization link for cloud browser enable", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "run-token");

    server.use(
      http.post(
        "http://localhost:3000/api/browser/authorization-requests",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe("Bearer run-token");
          return HttpResponse.json({
            authorizationUrl:
              "https://app.okou.ai/browser/authorize/vm0_browser_authorization_request_test",
            expiresAt: "2026-07-27T13:00:00.000Z",
          });
        },
      ),
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "browser",
      "--permission",
      "browser:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Cloud browser needs to be enabled for this chat thread",
    );
    expect(logCalls).toContain(
      "https://app.okou.ai/browser/authorize/vm0_browser_authorization_request_test",
    );
    expect(logCalls).toContain("This link expires at 2026-07-27T13:00:00.000Z");
    expect(logCalls).not.toContain(
      "Cloud browser authorization link unavailable",
    );
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("exits with an error for an invalid permission name", async () => {
    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "nonexistent:perm",
        "--url",
        SLACK_READ_URL,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        `Permission "nonexistent:perm" does not match GET ${SLACK_READ_URL}`,
      ),
    );
  });
});

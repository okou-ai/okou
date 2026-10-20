import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import {
  catalogItem,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";
import { stubCustomConnectors } from "../../__tests__/helpers/custom-connectors";
import { mailCommand } from "../index";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const THREAD_ID = "550e8400-e29b-41d4-a716-446655440001";
const MAIL_DRAFT_ID = "550e8400-e29b-41d4-a716-446655440002";
const RUN_GMAIL_CONNECTION_ID = "550e8400-e29b-41d4-a716-446655440003";

describe("okou mail", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("command exited");
  });
  let directory = "";
  let contextPath = "";

  function writeRunContext(): void {
    writeFileSync(
      contextPath,
      JSON.stringify({
        schemaVersion: 1,
        targets: [
          {
            kind: "builtin",
            connectorSlug: "gmail",
            connectionId: RUN_GMAIL_CONNECTION_ID,
          },
          {
            kind: "builtin",
            connectorSlug: "outlook-mail",
            connectionId: null,
          },
        ],
      }),
      "utf8",
    );
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "okou-mail-account-"));
    contextPath = join(directory, "context.json");
    writeRunContext();
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", contextPath);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([["list"], ["connect", "gmail"]])(
    "requires Run Agent context: %s",
    async (...args) => {
      vi.stubEnv("OKOU_AGENT_ID", "");
      await expect(
        mailCommand.parseAsync(["node", "okou", ...args]),
      ).rejects.toThrow("command exited");
      expect(error.mock.calls.flat().join("\n")).toContain(
        "OKOU_AGENT_ID is not set",
      );
      expect(error.mock.calls.flat().join("\n")).toContain(
        "Run this command from an active agent run",
      );
      expect(mockConsoleLog).not.toHaveBeenCalled();
    },
  );

  it("lists the exact mail account used by the run and keeps unadmitted mail unavailable", async () => {
    server.use(
      stubConnectorCatalog([
        catalogItem({ connectorSlug: "gmail", label: "Gmail" }),
        catalogItem({
          connectorSlug: "outlook-mail",
          label: "Outlook Mail",
        }),
      ]),
      stubCustomConnectors([]),
      http.post(
        "http://localhost:3000/api/connector-accounts/inspect",
        async ({ request }) => {
          const body = connectorAccountsContract.inspect.body.parse(
            await request.json(),
          );
          return HttpResponse.json({
            results: body.selections.map((selection) => {
              return {
                setupStatus: "complete",
                missingRequiredFields: [],
                configuredFieldKeys: [],
                kind: "available" as const,
                ...selection,
                authMethod: "oauth" as const,
                displayName: "Selected Gmail",
                externalId: "selected-gmail-account",
                externalUsername: null,
                externalEmail: "selected@example.com",
                connectionStatus: "connected" as const,
                reconnectReason: null,
              };
            }),
          });
        },
      ),
    );

    await mailCommand.parseAsync(["node", "cli", "list"]);

    const listOutput = mockConsoleLog.mock.calls.flat().join("\n");
    expect(listOutput).toContain("gmail");
    expect(listOutput).toContain("selected@example.com");
    expect(listOutput).not.toContain("sender@example.com");
    expect(listOutput).toContain("ready");
    expect(listOutput).toContain("outlook");
    expect(listOutput).toContain("unavailable");

    mockConsoleLog.mockClear();
    await mailCommand.parseAsync(["node", "cli", "connect", "gmail", "--json"]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        provider: "gmail",
        action: "ready",
        url: null,
        context: "run",
        connectionId: RUN_GMAIL_CONNECTION_ID,
      },
    );

    mockConsoleLog.mockClear();
    await mailCommand.parseAsync([
      "node",
      "cli",
      "connect",
      "outlook",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        provider: "outlook",
        action: "unavailable",
        url: null,
        context: "run",
        connectionId: null,
      },
    );
  });

  it("returns an exact reconnect link for the Gmail account used by the run", async () => {
    server.use(
      stubConnectorCatalog([
        catalogItem({ connectorSlug: "gmail", label: "Gmail" }),
        catalogItem({
          connectorSlug: "outlook-mail",
          label: "Outlook Mail",
        }),
      ]),
      stubCustomConnectors([]),
      http.post(
        "http://localhost:3000/api/connector-accounts/inspect",
        async ({ request }) => {
          const body = connectorAccountsContract.inspect.body.parse(
            await request.json(),
          );
          return HttpResponse.json({
            results: body.selections.map((selection) => {
              return {
                setupStatus: "complete",
                missingRequiredFields: [],
                configuredFieldKeys: [],
                kind: "available" as const,
                ...selection,
                authMethod: "oauth" as const,
                displayName: "Selected Gmail",
                externalId: "selected-gmail-account",
                externalUsername: null,
                externalEmail: "selected@example.com",
                connectionStatus: "reconnect-required" as const,
                reconnectReason: "authorization_expired_or_revoked" as const,
              };
            }),
          });
        },
      ),
    );

    await mailCommand.parseAsync(["node", "cli", "connect", "gmail", "--json"]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        provider: "gmail",
        action: "reconnect",
        url: `http://localhost:3000/connectors/gmail/reconnect/${RUN_GMAIL_CONNECTION_ID}?agentId=${AGENT_ID}`,
        context: "run",
        connectionId: RUN_GMAIL_CONNECTION_ID,
      },
    );
  });

  it("does not show a sibling sender when run account metadata is unavailable", async () => {
    server.use(
      stubConnectorCatalog([
        catalogItem({ connectorSlug: "gmail", label: "Gmail" }),
        catalogItem({
          connectorSlug: "outlook-mail",
          label: "Outlook Mail",
        }),
      ]),
      stubCustomConnectors([]),
      http.post(
        "http://localhost:3000/api/connector-accounts/inspect",
        async ({ request }) => {
          const body = connectorAccountsContract.inspect.body.parse(
            await request.json(),
          );
          return HttpResponse.json({
            results: body.selections.map((selection) => {
              return { kind: "unavailable" as const, ...selection };
            }),
          });
        },
      ),
    );

    await mailCommand.parseAsync(["node", "cli", "list"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("gmail");
    expect(output).toContain("unavailable");
    expect(output).not.toContain("sender@example.com");
    expect(output).not.toContain("ready");

    mockConsoleLog.mockClear();
    await mailCommand.parseAsync(["node", "cli", "connect", "gmail", "--json"]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        provider: "gmail",
        action: "unavailable",
        url: null,
        context: "run",
        connectionId: RUN_GMAIL_CONNECTION_ID,
      },
    );
  });

  it("links an existing Gmail draft and shows a standalone review URL example", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/mail/drafts/link",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(await request.json()).toStrictEqual({
            threadId: THREAD_ID,
            agentId: AGENT_ID,
            gmailDraftId: "r-test-draft",
          });
          return HttpResponse.json(
            {
              mailDraftId: MAIL_DRAFT_ID,
              mailDraftUrl: `https://app.okou.ai/mail/drafts/${MAIL_DRAFT_ID}`,
            },
            { status: 200 },
          );
        },
      ),
    );

    await mailCommand.parseAsync(["node", "cli", "link", "r-test-draft"]);

    expect(mockConsoleLog).toHaveBeenCalledOnce();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining(
        `Example reply:\n\nYour email draft is ready to review and send.\n\nhttps://app.okou.ai/mail/drafts/${MAIL_DRAFT_ID}`,
      ),
    );
  });

  it("adds a callback prompt to the review URL for a single draft", async () => {
    server.use(
      http.post("http://localhost:3000/api/mail/drafts/link", () => {
        return HttpResponse.json(
          {
            mailDraftId: MAIL_DRAFT_ID,
            mailDraftUrl: `https://app.okou.ai/mail/drafts/${MAIL_DRAFT_ID}?source=gmail`,
          },
          { status: 200 },
        );
      }),
    );

    await mailCommand.parseAsync([
      "node",
      "cli",
      "link",
      "r-test-draft",
      "--callback-prompt",
      "Confirm the email was sent",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    const reviewUrl = new URL(output.match(/^https:\/\/\S+$/m)?.[0] ?? "");
    expect(reviewUrl.pathname).toBe(`/mail/drafts/${MAIL_DRAFT_ID}`);
    expect(Array.from(reviewUrl.searchParams.entries())).toStrictEqual([
      ["source", "gmail"],
      ["agentId", AGENT_ID],
      ["threadId", THREAD_ID],
      ["callbackPrompt", "Confirm the email was sent"],
    ]);
    expect(output).toContain("end the current turn");
    expect(output).toContain("exact callback URL above verbatim");
    expect(output).toContain("omitting any query parameters");
  });
});

import { capturedRunToken } from "../../../test/fixtures/captured-run-token";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectorCheckTargetAwareUrlRequestSchema,
  type ConnectorCheckPolicy,
} from "@okouai/api-contracts/contracts/connector-check";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import {
  catalogItem,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";
import { permissionRequestCommand } from "../permission-request";

const CHAT_THREAD_ID = "20000000-0000-4000-8000-000000000001";

const slack = {
  connector: "slack",
  permission: "chat:write",
  url: "https://slack.com/api/chat.postMessage",
  method: "POST",
};
const gmail = {
  connector: "gmail",
  permission: "messages.send",
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  method: "POST",
};

// All fixtures cross the real diagnostic HTTP boundary; no provider operation is sent.
function diagnostics(
  policies: ConnectorCheckPolicy[] = [{ outcome: "ask", basis: "ask-list" }],
  names: readonly string[] = [],
) {
  let index = 0;
  server.use(
    stubConnectorCatalog(
      [
        catalogItem({ connectorSlug: "slack", label: "Slack" }),
        catalogItem({ connectorSlug: "gmail", label: "Gmail" }),
      ],
      "https://app.okou.ai",
    ),
    http.post(
      "https://app.okou.ai/api/connectors/diagnostics/check",
      async ({ request }) => {
        const input = connectorCheckTargetAwareUrlRequestSchema.parse(
          await request.json(),
        );
        if (input.target?.kind !== "builtin")
          throw new Error("Expected builtin target");
        const isGmail = input.target.connectorSlug === "gmail";
        const base = isGmail
          ? "https://gmail.googleapis.com"
          : "https://slack.com/api";
        return HttpResponse.json({
          outcome: "resolved",
          mode: "url",
          connector: {
            target: input.target,
            label: isGmail ? "Gmail" : "Slack",
            visibility: "available",
            credentialResolution: "network-boundary",
          },
          environmentNames: [isGmail ? "GMAIL_TOKEN" : "SLACK_TOKEN"],
          run: { status: "configured", bases: [base] },
          method: input.method,
          base,
          relativePath: new URL(input.url).pathname,
          permission: {
            kind: "matched",
            permissions: [
              {
                name:
                  names[index] ??
                  (isGmail ? gmail.permission : slack.permission),
                policy: policies[index++] ?? policies[0],
              },
            ],
          },
        });
      },
    ),
  );
}

describe("okou connector permission-request --batch-file", () => {
  let directory: string;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  const output = () => {
    return log.mock.calls.flat().join("\n");
  };
  const errors = () => {
    return error.mock.calls.flat().join("\n");
  };
  async function run(input: unknown, flags: string[] = []) {
    const file = join(directory, "permissions.json");
    await writeFile(file, JSON.stringify(input));
    await permissionRequestCommand.parseAsync([
      "node",
      "okou",
      "--batch-file",
      file,
      ...flags,
    ]);
  }
  function actionUrl() {
    const url = output()
      .split("\n")
      .find((line) => {
        return line.startsWith("https://");
      });
    if (!url) throw new Error("Missing batch action URL");
    return new URL(url);
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "okou-permission-batch-"));
    vi.stubEnv("OKOU_TOKEN", capturedRunToken([]));
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", CHAT_THREAD_ID);
    diagnostics();
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
  });

  it("diagnoses cross-connector endpoints and deduplicates grants into one link", async () => {
    await run([
      slack,
      gmail,
      { ...slack, url: "https://slack.com/api/chat.update" },
    ]);
    const url = actionUrl();
    expect(url.pathname).toBe("/connectors/permissions/batch");
    expect(url.searchParams.get("orgId")).toBe("test-org");
    expect(url.searchParams.get("userId")).toBe("test-user");
    expect(url.searchParams.has("threadId")).toBe(false);
    expect(JSON.parse(url.searchParams.get("items") ?? "")).toStrictEqual([
      { connectorSlug: "slack", permission: slack.permission },
      { connectorSlug: "gmail", permission: gmail.permission },
    ]);
    expect(url.searchParams.get("action")).toBe("allow");
    expect(output()).toContain("Item 3: slack / chat:write: ask");
    expect(output()).toContain("AS THE USER");
    expect(output()).toContain("send emails directly as the user");
    expect(output()).toContain("user chooses the duration");
  });

  it("skips allowed items while requesting remaining denied permissions", async () => {
    diagnostics([
      { outcome: "allow", basis: "allow-list" },
      { outcome: "deny", basis: "deny-list" },
    ]);
    await run([slack, gmail]);
    expect(
      JSON.parse(actionUrl().searchParams.get("items") ?? ""),
    ).toStrictEqual([{ connectorSlug: "gmail", permission: gmail.permission }]);
    expect(output()).toContain("already allowed; skipped");
    expect(output()).toContain("provider-side diagnosis");
  });

  it("prints no approval or callback instruction when all items are allowed", async () => {
    diagnostics([{ outcome: "allow", basis: "allow-list" }]);
    await run([slack], ["--callback-prompt", "Continue"]);
    expect(output()).toContain("All requested permissions are already allowed");
    expect(output()).not.toContain("action=allow");
    expect(output()).not.toContain("end the current turn");
  });

  it("rejects a callback to a malformed Chat before printing a batch link", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "invalid-chat");
    await expect(
      run([slack, gmail], ["--callback-prompt", "Continue"]),
    ).rejects.toThrow("exit");
    expect(errors()).toContain(
      "--callback-prompt requires the current web chat",
    );
    expect(output()).not.toContain("action=allow");
  });

  it("adds exactly one callback to the single batch action", async () => {
    await run([slack, gmail], ["--callback-prompt", "Continue & verify"]);
    expect(actionUrl().searchParams.get("threadId")).toBe(CHAT_THREAD_ID);
    expect(actionUrl().searchParams.getAll("callbackPrompt")).toStrictEqual([
      "Continue & verify",
    ]);
    expect(output().match(/end the current turn/g)).toHaveLength(1);
  });

  it("does not emit a partial action if a later endpoint maps to another permission", async () => {
    await expect(
      run([slack, { ...gmail, permission: "drafts.write" }]),
    ).rejects.toThrow("exit");
    expect(errors()).toContain("does not match");
    expect(output()).not.toContain("action=allow");
  });

  it("still diagnoses duplicate grants for different endpoints", async () => {
    diagnostics([
      { outcome: "ask", basis: "ask-list" },
      { outcome: "unavailable", basis: "not-run-scoped" },
    ]);
    await expect(
      run([slack, { ...slack, url: "https://slack.com/api/chat.update" }]),
    ).rejects.toThrow("exit");
    expect(errors()).toContain("policy is unavailable");
    expect(output()).not.toContain("action=allow");
  });

  it.each([
    ["slack"],
    ["--permission", "chat:write"],
    ["--url", slack.url],
    ["--method", "GET"],
    ["--aws-service", "sts"],
    ["--aws-action", "GetCallerIdentity"],
    ["--aws-target", "Target"],
    ["--aws-query-param", "Action=GetCallerIdentity"],
    ["--aws-header-present", "x-amz-copy-source"],
  ])("excludes single-request arguments %j", async (...flags) => {
    await expect(run([slack], flags)).rejects.toThrow("exit");
    expect(errors()).toContain("cannot be combined");
    expect(output()).not.toContain("action=allow");
  });

  it.each([
    { input: [] },
    {
      input: Array.from({ length: 21 }, () => {
        return slack;
      }),
    },
    { input: [{ ...slack, expiresIn: 3600 }] },
    { input: [{ ...slack, method: undefined }] },
  ])("rejects invalid batch shape %# before any action", async ({ input }) => {
    await expect(run(input)).rejects.toThrow("exit");
    expect(errors()).toContain("Invalid batch file");
    expect(output()).not.toContain("action=allow");
  });

  it("enforces the final encoded URL byte limit including callback", async () => {
    const operations = Array.from({ length: 20 }, (_, index) => {
      return {
        ...slack,
        permission: `${"x:".repeat(63)}${index}`,
      };
    });
    const permissions = operations.map(({ permission }) => {
      return permission;
    });
    diagnostics(undefined, permissions);
    await run(operations);
    expect(Buffer.byteLength(actionUrl().href)).toBeLessThanOrEqual(8192);
    log.mockClear();
    diagnostics(undefined, permissions);
    await expect(
      run(operations, ["--callback-prompt", "继".repeat(200)]),
    ).rejects.toThrow("exit");
    expect(errors()).toContain("exceeds 8192 UTF-8 bytes");
    expect(output()).not.toContain("action=allow");
  });

  it("reports an unreadable file without generating an action", async () => {
    await expect(
      permissionRequestCommand.parseAsync([
        "node",
        "okou",
        "--batch-file",
        join(directory, "missing.json"),
      ]),
    ).rejects.toThrow("exit");
    expect(errors()).toContain("readable JSON file");
    expect(output()).not.toContain("action=allow");
  });
});

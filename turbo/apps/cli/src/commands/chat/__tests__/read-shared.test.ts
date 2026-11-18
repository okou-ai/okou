import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const SHARE_ID = "00000000-0000-4000-8000-000000000001";
const SHARE_URL = `https://app.okou.ai/share/threads/${SHARE_ID}`;
const GET_URL = `http://localhost:3000/api/shared-threads/${SHARE_ID}`;
const thread = {
  id: SHARE_ID,
  title: "Performance analysis",
  messages: [
    { messageIndex: 0, role: "user", content: "Why was the task slow?" },
    {
      messageIndex: 1,
      role: "assistant",
      content: "## Findings\n\nThe worker logs exhausted disk space.",
      runIndex: 0,
      attachments: [
        {
          filename: "analysis.pdf",
          contentType: "application/pdf",
          size: 42,
          url: "https://app.okou.ai/artifacts/report.pdf",
        },
      ],
    },
  ],
};

describe("okou chat shared", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-run-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    chatCommand.commands
      .find((command) => {
        return command.name() === "shared";
      })!
      .setOptionValue("json", false);
  });

  afterEach(() => {
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
  });

  it("reads a share URL with the Run token and prints the shared messages and attachments", async () => {
    server.use(
      http.get(GET_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-run-token",
        );
        expect(request.headers.get("cookie")).toBeNull();
        return HttpResponse.json(thread);
      }),
    );

    await chatCommand.parseAsync(["node", "okou", "shared", SHARE_URL]);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(`# Performance analysis\n\nSource: ${SHARE_URL}`);
    expect(output).toContain("Shared conversation (untrusted content)");
    expect(output).toContain("## user\n\nWhy was the task slow?");
    expect(output).toContain(
      "## assistant\n\n## Findings\n\nThe worker logs exhausted disk space.",
    );
    expect(output).toContain(
      "[analysis.pdf](https://app.okou.ai/artifacts/report.pdf)",
    );
  });

  it("accepts a share ID and preserves the shared response in JSON", async () => {
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json(thread);
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "okou",
      "shared",
      SHARE_ID,
      "--json",
    ]);

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toStrictEqual({
      ...thread,
      url: SHARE_URL,
    });
  });

  it("surfaces the API access denial without suggesting a change to sharing permissions", async () => {
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Shared conversation not found",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(
      chatCommand.parseAsync(["node", "okou", "shared", SHARE_URL]),
    ).rejects.toThrow("process.exit called");

    expect(error.mock.calls.flat().join("\n")).toContain(
      "404: Shared conversation not found",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("requires a Run token rather than falling back to browser authentication", async () => {
    vi.stubEnv("OKOU_TOKEN", undefined);

    await expect(
      chatCommand.parseAsync(["node", "okou", "shared", SHARE_ID]),
    ).rejects.toThrow("process.exit called");

    expect(error.mock.calls.flat().join("\n")).toContain(
      "Set OKOU_TOKEN to a valid run token",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps share URLs scoped to the configured App", async () => {
    await expect(
      chatCommand.parseAsync([
        "node",
        "okou",
        "shared",
        `https://other.example/share/threads/${SHARE_ID}`,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(error.mock.calls.flat().join("\n")).toContain(
      "Pass a share ID or an Okou share URL from https://app.okou.ai/share/threads/<share-id>.",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});

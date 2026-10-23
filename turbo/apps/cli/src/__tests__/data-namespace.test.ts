import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../mocks/server";
import { registerRequestedCommand } from "../okou";

describe("managed research through the canonical CLI entry point", () => {
  let output: string;

  beforeEach(() => {
    output = "";
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", undefined);
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      output += values.join(" ") + "\n";
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function run(args: string[]): Promise<void> {
    const argv = ["node", "okou", ...args];
    const cli = new Command("okou");
    await registerRequestedCommand(cli, argv);
    function reset(command: Command): void {
      command.exitOverride().configureOutput({
        writeOut: (text) => {
          output += text;
        },
        writeErr: (text) => {
          output += text;
        },
      });
      for (const option of command.options) {
        command.setOptionValue(option.attributeName(), option.defaultValue);
      }
      command.commands.forEach(reset);
    }
    reset(cli);
    await cli.parseAsync(argv);
  }

  it.each([
    ["social"],
    ["finance"],
    ["maps"],
    ["weather"],
    ["seo"],
    ["commerce"],
    ["web", "search"],
    ["web", "scrape"],
    ["people", "search"],
  ])("shows help at okou data %s", async (...path) => {
    await expect(run(["data", ...path, "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(output).toContain(`Usage: okou data ${path.join(" ")}`);
  });

  it("uses the managed web API through okou data web search", async () => {
    let requestBody: unknown;
    server.use(
      http.post("http://localhost:3000/api/web-search", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          query: "business productivity",
          limit: 5,
          provider: "perplexity",
          billingCategory: "request",
          billingQuantity: 1,
          creditsCharged: 5,
          results: [],
        });
      }),
    );
    await run(["data", "web", "search", "business productivity", "--json"]);
    expect(requestBody).toMatchObject({
      query: "business productivity",
      limit: 5,
    });
    expect(output).toContain('"provider":"perplexity"');
  });

  it("keeps research people search on its existing API", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/people-search",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            query: "marketing leaders in London",
            limit: 5,
            provider: "perplexity",
            billingCategory: "request",
            billingQuantity: 1,
            creditsCharged: 20,
            profiles: [],
          });
        },
      ),
    );
    await run([
      "data",
      "people",
      "search",
      "marketing leaders in London",
      "--json",
    ]);
    expect(requestBody).toEqual({
      query: "marketing leaders in London",
      limit: 5,
    });
    expect(output).toContain('"profiles":[]');
  });

  it("keeps web-chat message search under okou search", async () => {
    let keyword: string | null = null;
    server.use(
      http.get("http://localhost:3000/api/chat/search", ({ request }) => {
        keyword = new URL(request.url).searchParams.get("keyword");
        return HttpResponse.json({
          results: [
            {
              chatThreadId: "thread-marketing",
              agentName: "Okou",
              matchedMessage: {
                chatThreadId: "thread-marketing",
                role: "assistant",
                content: "Launch notes for the campaign",
                createdAt: "2026-10-20T10:00:00Z",
                seqId: 1,
                runId: null,
              },
            },
          ],
        });
      }),
    );
    await run(["search", "launch notes", "--source", "chat"]);
    expect(keyword).toBe("launch notes");
    expect(output).toContain("Launch notes for the campaign");
    expect(output).toContain("thread-marketing");
  });

  it("keeps local session discovery under okou search", async () => {
    await run(["search", "failed tool call", "--source", "agent-session"]);
    expect(output).toContain("/home/user/.claude/projects/");
    expect(output).toContain("/home/user/.codex/sessions/");
  });

  it("delivers local files to web chat through okou web upload-file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okou-data-web-"));
    const filePath = join(directory, "report.txt");
    const bytes = Buffer.from("Research summary\n");
    const file = {
      id: "00000000-0000-4000-8000-000000000028",
      filename: "report.txt",
      contentType: "text/plain",
      size: bytes.length,
      url: "https://cdn.example.test/report.txt",
    };
    let uploadedBytes: ArrayBuffer | undefined;
    server.use(
      http.post("http://localhost:3000/api/uploads/prepare", () => {
        return HttpResponse.json({
          ...file,
          uploadUrl: "https://uploads.example.test/report",
        });
      }),
      http.put("https://uploads.example.test/report", async ({ request }) => {
        uploadedBytes = await request.arrayBuffer();
        return new HttpResponse(null, { status: 200 });
      }),
      http.post("http://localhost:3000/api/uploads/complete", () => {
        return HttpResponse.json(file);
      }),
    );
    try {
      await writeFile(filePath, bytes);
      await run(["web", "upload-file", "-f", filePath, "--json"]);
      expect(uploadedBytes).toEqual(new Uint8Array(bytes).buffer);
      expect(JSON.parse(output)).toMatchObject(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["upload-file", "download-file"])(
    "keeps web-chat %s under okou web",
    async (operation) => {
      await expect(run(["web", operation, "--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(output).toContain(`Usage: okou web ${operation}`);
    },
  );
});

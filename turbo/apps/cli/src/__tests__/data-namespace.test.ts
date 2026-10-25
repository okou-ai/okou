import { dataRouterTool } from "../mocks/data-router";
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

  it("calls a Router tool through the canonical CLI entry point", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("new_research_tool", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({ results: [{ newField: "kept" }] });
      }),
    );
    await run([
      "data",
      "call",
      "new_research_tool",
      "--input",
      '{"query":"business productivity","newOption":true}',
      "--json",
    ]);
    expect(requestBody).toEqual({
      query: "business productivity",
      newOption: true,
    });
    expect(JSON.parse(output)).toEqual({ results: [{ newField: "kept" }] });
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

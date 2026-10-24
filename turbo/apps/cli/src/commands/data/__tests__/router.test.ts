import {
  isJSONRPCNotification,
  isJSONRPCRequest,
} from "@modelcontextprotocol/client";
import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { installPaidToolPolicy } from "../../../lib/command/paid-tools";
import { server } from "../../../mocks/server";
import { createDataCommand } from "../index";

const endpoint = "https://router.test/mcp";
const outputSchema = z.object({
  tools: z.array(z.object({ name: z.string() })),
});

function program(): Command {
  const command = new Command("okou").addCommand(createDataCommand());
  installPaidToolPolicy(command);
  return command;
}

describe("Data Router command discovery", () => {
  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    vi.stubEnv("OKOU_DATA_ROUTER_URL", endpoint);
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", "[]");
  });
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("lists enabled static tools and honors both individual and family preferences", async () => {
    vi.stubEnv(
      "OKOU_DISABLED_PAID_TOOLS",
      JSON.stringify(["data:finance_search", "seo"]),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["node", "okou", "data", "tools", "--json"]);
    const printed = z.string().parse(log.mock.calls[0]?.[0]);
    const tools = outputSchema.parse(JSON.parse(printed)).tools.map((tool) => {
      return tool.name;
    });
    expect(tools).toContain("finance_quote");
    expect(tools).not.toContain("finance_search");
    expect(tools).not.toContain("seo_serp");
  });
  it("hides disabled commands from help while keeping enabled siblings discoverable", async () => {
    vi.stubEnv(
      "OKOU_DISABLED_PAID_TOOLS",
      JSON.stringify(["data:finance_search"]),
    );
    const command = program();
    let output = "";
    function capture(current: Command): void {
      current.exitOverride().configureOutput({
        writeOut(text) {
          output += text;
        },
      });
      for (const child of current.commands) capture(child);
    }
    capture(command);
    await expect(
      command.parseAsync(["node", "okou", "data", "finance", "--help"]),
    ).rejects.toMatchObject({ exitCode: 0 });
    expect(output).toContain("quote");
    expect(output).not.toMatch(/^\s+search(?:\s|\[|<)/mu);
  });
  it("filters the offline Social capability catalog by individual tools", async () => {
    vi.stubEnv(
      "OKOU_DISABLED_PAID_TOOLS",
      JSON.stringify(["data:youtube_search", "data:social_data_create"]),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync([
      "node",
      "okou",
      "data",
      "social",
      "capabilities",
      "youtube",
      "--json",
    ]);
    const printed = z.string().parse(log.mock.calls[0]?.[0]);
    const catalog = z
      .object({
        capabilities: z.array(z.object({ operations: z.array(z.string()) })),
      })
      .parse(JSON.parse(printed));
    expect(catalog.capabilities[0]?.operations).toContain("transcript");
    expect(catalog.capabilities[0]?.operations).not.toContain("search");
  });
  it("allows an explicit known tool call despite disabled discovery preferences", async () => {
    vi.stubEnv(
      "OKOU_DISABLED_PAID_TOOLS",
      JSON.stringify(["data:finance_search", "finance"]),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let called: unknown;
    server.use(
      http.all(endpoint, async ({ request }) => {
        if (request.method === "GET" || request.method === "HEAD")
          return new HttpResponse(null, { status: 405 });
        if (request.method === "DELETE")
          return new HttpResponse(null, { status: 204 });
        const message: unknown = await request.json();
        if (isJSONRPCNotification(message))
          return new HttpResponse(null, { status: 204 });
        if (!isJSONRPCRequest(message))
          return new HttpResponse(null, { status: 400 });
        if (message.method === "server/discover")
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        if (message.method === "initialize")
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "router", version: "1.0.0" },
            },
          });
        if (message.method === "tools/call") {
          called = message.params;
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: '{"symbols":["AAPL"]}' }],
              structuredContent: {
                data: { status: 200, body: { symbols: ["AAPL"] } },
              },
            },
          });
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported method" },
        });
      }),
    );
    await program().parseAsync([
      "node",
      "okou",
      "data",
      "call",
      "finance_search",
      "--input",
      '{"query":"Apple"}',
      "--json",
    ]);
    expect(called).toMatchObject({
      name: "finance_search",
      arguments: { query: "Apple" },
    });
    expect(log.mock.calls.flat().join("\n")).toContain('"symbols":["AAPL"]');
  });
});

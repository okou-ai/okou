import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { registerRequestedCommand } from "../../../../okou";
import { groupListCommand } from "../list";

const LIST_URL = "http://localhost:3000/api/integrations/agentphone/groups";

async function listGroups(...args: string[]) {
  const program = new Command();
  await registerRequestedCommand(program, ["node", "okou", "imessage"]);
  await program.parseAsync([
    "node",
    "okou",
    "imessage",
    "group",
    "list",
    ...args,
  ]);
}

describe("okou imessage group list", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    groupListCommand.setOptionValue("limit", "25");
    groupListCommand.setOptionValue("cursor", undefined);
    groupListCommand.setOptionValue("json", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("discovers a named group and shows how to read and send using its group ID", async () => {
    server.use(
      http.get(LIST_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          groups: [
            {
              groupId: "grp_project",
              conversationId: "conv_project",
              groupName: "Project team",
              agentphoneAgentId: "agent_okou",
              lastMessageAt: "2026-11-03T01:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }),
    );
    await listGroups();
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain(
      "grp_project  Project team  2026-11-03T01:00:00.000Z",
    );
    expect(text).toContain(
      "Conversation: conv_project  Phone agent: agent_okou",
    );
    expect(text).toContain("okou imessage group history --group <groupId>");
    expect(text).toContain("okou imessage message send --to <groupId>");
  });

  it("preserves a continuation cursor on an empty page in JSON output", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(LIST_URL, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({ groups: [], nextCursor: "next-page" });
      }),
    );
    await listGroups("--limit", "10", "--cursor", "previous-page", "--json");
    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      limit: "10",
      cursor: "previous-page",
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      groups: [],
      nextCursor: "next-page",
    });
  });

  it("guides an empty page reader to continue rather than claiming there are no groups", async () => {
    server.use(
      http.get(LIST_URL, () => {
        return HttpResponse.json({ groups: [], nextCursor: "next-page" });
      }),
    );
    await listGroups();
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("No shared iMessage groups on this page");
    expect(text).toContain("Next cursor: next-page");
  });

  it("rejects an invalid page size before making a request", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    let requests = 0;
    server.use(
      http.get(LIST_URL, () => {
        requests += 1;
        return HttpResponse.json({ groups: [], nextCursor: null });
      }),
    );
    await expect(listGroups("--limit", "101")).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(requests).toBe(0);
    expect(error.mock.calls.flat().join("\n")).toContain("limit");
    exit.mockRestore();
    error.mockRestore();
  });
});

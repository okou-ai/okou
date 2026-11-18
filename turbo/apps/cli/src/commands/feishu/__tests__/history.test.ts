import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { createFeishuCommand } from "../index";

const output = vi.spyOn(console, "log").mockImplementation(() => {});
beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_TOKEN", "test-token");
});
describe("Official Feishu group reads", () => {
  it("preserves an empty shared-chat page's continuation cursor", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/integrations/feishu/official/chats",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("cursor")).toBe(
            "previous",
          );
          return HttpResponse.json({
            installationId: "00000000-0000-4000-8000-000000000001",
            chats: [],
            hasMore: true,
            nextCursor: "continue",
          });
        },
      ),
    );
    await createFeishuCommand("feishu").parseAsync([
      "node",
      "cli",
      "chat",
      "list",
      "--cursor",
      "previous",
      "--json",
    ]);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"nextCursor": "continue"'),
    );
  });
  it("passes explicit time bounds and the page cursor to shared history", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/integrations/feishu/official/messages",
        ({ request }) => {
          const query = new URL(request.url).searchParams;
          expect(query.get("chat")).toBe("oc_shared");
          expect(query.get("startTime")).toBe("100");
          expect(query.get("endTime")).toBe("200");
          expect(query.get("cursor")).toBe("next");
          return HttpResponse.json({
            installationId: "00000000-0000-4000-8000-000000000001",
            chat: "oc_shared",
            chatUrl:
              "https://applink.feishu.cn/client/chat/open?openChatId=oc_shared",
            messages: [{ message_id: "om_read", msg_type: "text" }],
            hasMore: false,
            nextCursor: null,
          });
        },
      ),
    );
    await createFeishuCommand("feishu").parseAsync([
      "node",
      "cli",
      "message",
      "history",
      "--chat",
      "oc_shared",
      "--start-time",
      "100",
      "--end-time",
      "200",
      "--cursor",
      "next",
      "--json",
    ]);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"message_id": "om_read"'),
    );
  });
});

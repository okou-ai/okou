import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { phoneCommand } from "../index";
import { imessageCommand } from "../../imessage";
import { createPhoneReactionCommand } from "../reaction";

const REACTION_URL = "http://localhost:3000/api/integrations/phone/reaction";

describe("okou phone reaction", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    output.mockClear();
    errors.mockClear();
  });

  it("adds an emoji through the phone command and prints its JSON receipt", async () => {
    const requests: unknown[] = [];
    const receipt = {
      ok: true,
      reactionId: "rxn_123",
      messageId: "apmsg_123",
      reaction: "🔥",
      channel: "imessage",
    };
    server.use(
      http.post(REACTION_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        requests.push(await request.json());
        return HttpResponse.json(receipt);
      }),
    );
    await phoneCommand.parseAsync([
      "node",
      "okou",
      "reaction",
      "apmsg_123",
      "--emoji",
      "🔥",
      "--json",
    ]);
    expect(requests).toStrictEqual([
      { messageId: "apmsg_123", reaction: "🔥" },
    ]);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toStrictEqual(
      receipt,
    );
  });

  it("accepts a tapback through imessage message react and reports acceptance", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(REACTION_URL, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          ok: true,
          reactionId: "rxn_456",
          messageId: "apmsg_456",
          reaction: "like",
          channel: "imessage",
        });
      }),
    );
    await imessageCommand.parseAsync([
      "node",
      "okou",
      "message",
      "react",
      "apmsg_456",
      "--emoji",
      "like",
    ]);
    expect(requests).toStrictEqual([
      { messageId: "apmsg_456", reaction: "like" },
    ]);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "Reaction accepted: like on apmsg_456",
    );
  });

  it.each([400, 502])(
    "surfaces a %s failure without retrying or changing the emoji",
    async (status) => {
      const requests: unknown[] = [];
      const message =
        status === 400
          ? "Custom emoji is not supported on this iMessage line"
          : "Phone reaction outcome is unknown. Do not retry automatically";
      server.use(
        http.post(REACTION_URL, async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json(
            { error: { code: "AGENTPHONE_ERROR", message } },
            { status },
          );
        }),
      );
      await expect(
        createPhoneReactionCommand().parseAsync([
          "node",
          "okou",
          "apmsg_123",
          "--emoji",
          "🔥",
        ]),
      ).rejects.toThrow("process.exit");
      expect(requests).toStrictEqual([
        { messageId: "apmsg_123", reaction: "🔥" },
      ]);
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(output).not.toHaveBeenCalled();
    },
  );
});

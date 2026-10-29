import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createPhoneMessageCommand } from "../message";

const GROUP_URL =
  "http://localhost:3000/api/integrations/agentphone/group-message";
const PHONE_URL = "http://localhost:3000/api/integrations/phone/message";

describe("okou imessage message send", () => {
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

  it.each(["grp_abc123", "chat:grp_abc123"])(
    "sends --to %s through the group API and prints the standard receipt",
    async (to) => {
      const requests: unknown[] = [];
      server.use(
        http.post(GROUP_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          requests.push(await request.json());
          return HttpResponse.json({
            ok: true,
            messageId: "apmsg_group",
            channel: "imessage",
            toNumber: "grp_abc123",
          });
        }),
      );
      await createPhoneMessageCommand("imessage").parseAsync([
        "node",
        "okou",
        "--to",
        to,
        "--as",
        "agt_group",
        "--text",
        "Team update",
        "--json",
      ]);
      expect(requests).toStrictEqual([
        {
          groupId: "grp_abc123",
          agentphoneAgentId: "agt_group",
          text: "Team update",
        },
      ]);
      expect(JSON.parse(output.mock.calls.flat().join("\n"))).toStrictEqual({
        integration: "imessage",
        chatId: "grp_abc123",
        messages: [{ id: "apmsg_group", url: null }],
      });
    },
  );

  it("keeps --to me on the existing phone API", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(PHONE_URL, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          ok: true,
          messageId: "apmsg_dm",
          channel: "imessage",
          toNumber: "me@example.com",
        });
      }),
    );
    await createPhoneMessageCommand("imessage").parseAsync([
      "node",
      "okou",
      "--to",
      "me",
      "--text",
      "Private update",
      "--json",
    ]);
    expect(requests).toStrictEqual([{ text: "Private update" }]);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toMatchObject({
      chatId: "me@example.com",
    });
  });

  it("reports an unavailable group API without falling back to the phone API", async () => {
    let privateSends = 0;
    server.use(
      http.post(GROUP_URL, () => {
        return HttpResponse.json(
          {
            error: { code: "NOT_FOUND", message: "Group sending unavailable" },
          },
          { status: 404 },
        );
      }),
      http.post(PHONE_URL, () => {
        privateSends += 1;
        return HttpResponse.json({
          ok: true,
          messageId: "unexpected",
          channel: "sms",
          toNumber: "+15551234567",
        });
      }),
    );
    await expect(
      createPhoneMessageCommand("imessage").parseAsync([
        "node",
        "okou",
        "--to",
        "grp_abc123",
        "--text",
        "Group update",
      ]),
    ).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Group sending unavailable",
    );
    expect(privateSends).toBe(0);
  });

  it.each(["phone", "sms"] as const)(
    "keeps %s group destinations unsupported",
    async (integration) => {
      await expect(
        createPhoneMessageCommand(integration).parseAsync([
          "node",
          "okou",
          "--to",
          "grp_abc123",
          "--text",
          "Group update",
        ]),
      ).rejects.toThrow("process.exit");
      expect(errors.mock.calls.flat().join("\n")).toContain("use --to me");
    },
  );
});

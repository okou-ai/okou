import { beforeEach, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { whatsappCommand } from "../index";

const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});
beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_TOKEN", "test-token");
});

it("prints all WhatsApp part receipts as one JSON envelope", async () => {
  let requestBody: unknown;
  server.use(
    http.post(
      "http://localhost:3000/api/integrations/whatsapp/message",
      async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          channel: "whatsapp",
          toNumber: "+4915123456789",
          messages: [{ id: "part-1" }, { id: "part-2" }],
        });
      },
    ),
  );
  await whatsappCommand.parseAsync([
    "node",
    "cli",
    "message",
    "send",
    "--to",
    "me",
    "--text",
    "Hello",
    "--json",
  ]);
  expect(requestBody).toEqual({ text: "Hello" });
  expect(JSON.parse(output.mock.calls.flat().join("\n"))).toEqual({
    integration: "whatsapp",
    chatId: "+4915123456789",
    messages: [
      { id: "part-1", url: null },
      { id: "part-2", url: null },
    ],
  });
});

it("rejects an arbitrary recipient instead of borrowing another connection", async () => {
  await expect(
    whatsappCommand.parseAsync([
      "node",
      "cli",
      "message",
      "send",
      "--to",
      "+12025550123",
      "--text",
      "Hello",
    ]),
  ).rejects.toThrow("process.exit called");
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("only go to the phone connected"),
  );
});

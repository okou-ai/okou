import { expect, it, onTestFinished, vi } from "vitest";
import { literal } from "zod";
import { ConnectionDiagnostics } from "../connection-diagnostics";
import { BOT_TOKEN, CONTROL_SECRET, GATEWAY_SECRET } from "./relay-fixture";

it("redacts credentials, session data, payloads and arbitrary error fields from diagnostics", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    info.mockRestore();
    warn.mockRestore();
  });
  const privateData = [
    BOT_TOKEN,
    CONTROL_SECRET,
    GATEWAY_SECRET,
    "private-session-id",
    "private-message-body",
  ].join(" ");
  const namedError = new Error(privateData, { cause: privateData });
  namedError.name = privateData;
  namedError.stack = privateData;
  const validation = literal("expected").safeParse(privateData);
  expect(validation.success).toBe(false);
  const cases = [
    { error: namedError, type: "Error" },
    { error: new TypeError(privateData), type: "TypeError" },
    { error: new SyntaxError(privateData), type: "SyntaxError" },
    {
      error: new DOMException(privateData, "TimeoutError"),
      type: "TimeoutError",
    },
    { error: new DOMException(privateData, "AbortError"), type: "AbortError" },
    { error: new DOMException(privateData, privateData), type: "DOMException" },
    { error: validation.error, type: "ValidationError" },
    { error: { name: privateData, message: privateData }, type: "Unknown" },
  ];
  for (const { error, type } of cases) {
    const diagnostics = new ConnectionDiagnostics();
    diagnostics.transition("application-discovery");
    diagnostics.response(200);
    diagnostics.failure({ reason: "connection-error", error }, 1, 1000);
    expect(diagnostics.snapshot().lastFailure?.exceptionType).toBe(type);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain("private");
  }
  const output = JSON.stringify([info.mock.calls, warn.mock.calls]);
  expect(output).toContain("discord-gateway-connection-failure");
  for (const secret of privateData.split(" "))
    expect(output).not.toContain(secret);
});

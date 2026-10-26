import { describe, expect, it } from "vitest";
import { accept, HttpStatusError } from "../accept";

describe("accept", () => {
  it("preserves a handled response, its headers and its unread body", async () => {
    const response = new Response('{"reason":"missing"}', {
      status: 404,
      headers: {
        "content-type": "application/json",
        "x-request-id": "receipt",
      },
    });
    const accepted = await accept(Promise.resolve(response), [200, 404]);
    expect(accepted).toBe(response);
    expect(accepted.headers.get("x-request-id")).toBe("receipt");
    await expect(accepted.json()).resolves.toStrictEqual({ reason: "missing" });
  });

  it("retains an unexpected response for a provider-specific error decoder", async () => {
    const response = new Response('{"error":"invalid_grant"}', { status: 400 });
    const [result] = await Promise.allSettled([
      accept(Promise.resolve(response), [200]),
    ]);
    if (
      result?.status !== "rejected" ||
      !(result.reason instanceof HttpStatusError)
    ) {
      throw new Error("Expected an HTTP status error");
    }
    expect(result.reason.status).toBe(400);
    await expect(result.reason.response.json()).resolves.toStrictEqual({
      error: "invalid_grant",
    });
  });

  it("propagates the original transport failure", async () => {
    const error = new TypeError("connection failed");
    await expect(accept(Promise.reject(error), [200])).rejects.toBe(error);
  });
});

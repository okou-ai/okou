import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES } from "@okouai/api-contracts/contracts/browser-user-actions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { testContext } from "../../../__tests__/test-context";
import { setupRawAppRequest } from "../../../__tests__/test-helpers";
import { browserUserActionRoutes } from "../browser-user-actions";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const limit = BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES;
const headers = Object.freeze({
  authorization: "Bearer clerk-session",
  "content-type": "application/json",
});

async function inputRequest() {
  await updateFeatureSwitchesForUser(
    context,
    { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` },
    { [FeatureSwitchKey.BrowserNativeInput]: true },
  );
  return setupRawAppRequest({ context, routes: browserUserActionRoutes });
}

function applyPath() {
  return `/api/browser/user-actions/${randomUUID()}/apply`;
}

describe("Browser input request body policy", () => {
  it("rejects a declared body above the limit before JSON parsing", async () => {
    const request = await inputRequest();
    const response = await request(applyPath(), {
      method: "POST",
      headers: { ...headers, "content-length": String(limit + 1) },
      body: "{",
    });
    expect(response).toMatchObject({
      status: 400,
      body: { error: { message: "Browser input request is too large" } },
    });
  });

  it.each([undefined, "1"])(
    "bounds actual streamed bytes and cancels the producer with content-length=%s",
    async (contentLength) => {
      const request = await inputRequest();
      // The character count fits; the extra UTF-8 byte exceeds the limit.
      const bytes = new TextEncoder().encode(
        JSON.stringify({ values: [{ key: "name", value: "é" }] }).padEnd(
          limit,
          " ",
        ),
      );
      let offset = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset >= bytes.length) {
              throw new Error(
                "The oversized request producer was not cancelled",
              );
            }
            const chunk = bytes.subarray(offset, offset + 64 * 1024);
            offset += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const init: RequestInit & { readonly duplex: "half" } = {
        method: "POST",
        headers: {
          ...headers,
          ...(contentLength === undefined
            ? {}
            : { "content-length": contentLength }),
        },
        body,
        duplex: "half",
      };
      const response = await request(applyPath(), init);
      expect(response).toMatchObject({
        status: 400,
        body: { error: { message: "Browser input request is too large" } },
      });
      expect(cancelled).toBeTruthy();
      expect(body.locked).toBeFalsy();
    },
  );

  it("accepts the exact byte limit and decodes UTF-8 across stream chunks", async () => {
    const request = await inputRequest();
    const json = JSON.stringify({ values: [{ key: "name", value: "é" }] });
    const text =
      json + " ".repeat(limit - new TextEncoder().encode(json).length);
    const bytes = new TextEncoder().encode(text);
    const split = bytes.indexOf(0xc3) + 1;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const end = offset === 0 ? split : bytes.length;
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
        if (offset === bytes.length) {
          controller.close();
        }
      },
    });
    const init: RequestInit & { readonly duplex: "half" } = {
      method: "POST",
      headers: { ...headers, "content-length": String(limit) },
      body,
      duplex: "half",
    };
    const response = await request(applyPath(), init);
    // Valid input reaches the normal lookup for the caller-supplied token.
    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
    });
  });

  it.each([
    ["{", "Invalid JSON in request body"],
    [
      JSON.stringify({ values: "invalid" }),
      "values: Invalid input: expected array, received string",
    ],
  ])("preserves JSON and schema validation for %s", async (body, message) => {
    const request = await inputRequest();
    const response = await request(applyPath(), {
      method: "POST",
      headers,
      body,
    });
    expect(response).toMatchObject({
      status: 400,
      body: { error: { message } },
    });
  });
});

import { once } from "node:events";
import { Buffer } from "node:buffer";
import process from "node:process";
import { URLSearchParams } from "node:url";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

process.channel?.ref();
const configuration = once(process, "message");
process.send?.({ operation: "ready" });
const [config] = await configuration;
process.channel?.unref();

const dataKey = Buffer.from("0123456789abcdef0123456789abcdef");
const server = setupServer(
  http.post("https://kms.us-west-2.amazonaws.com/", ({ request }) => {
    if (request.headers.get("x-amz-target")?.endsWith("GenerateDataKey")) {
      return HttpResponse.json({
        KeyId: "fixture-kms-key",
        Plaintext: dataKey.toString("base64"),
        CiphertextBlob: Buffer.from("fixture-encrypted-key").toString("base64"),
      });
    }
    return HttpResponse.json({ Plaintext: dataKey.toString("base64") });
  }),
  http.post("https://login.link.com/auth/token", async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") !== "refresh_token" || form.has("scope")) {
      throw new Error(
        "Migration must refresh existing consent without adding scopes",
      );
    }
    const token = form.get("refresh_token");
    if (config.mode === "concurrent") {
      process.channel?.ref();
      const continuation = once(process, "message");
      process.send?.({ operation: "refresh", token });
      await continuation;
      process.channel?.unref();
    } else {
      process.send?.({ operation: "refresh", token });
    }
    if (config.mode === "refresh-failure") {
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    }
    return HttpResponse.json({
      access_token: `rotated-access-${token}`,
      refresh_token: `rotated-refresh-${token}`,
      expires_in: 3600,
      scope: "payment_methods.agentic userinfo:read",
      authorization_details: [
        { type: "source", actions: ["read_link_transactions"] },
      ],
      token_type: "Bearer",
    });
  }),
  http.post("https://login.link.com/auth/revoke", async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    process.send?.({ operation: "revoke", token: form.get("token") });
    if (config.mode === "revoke-failure") {
      return HttpResponse.json({ error: "unavailable" }, { status: 503 });
    }
    return HttpResponse.json({});
  }),
);

server.listen({ onUnhandledRequest: "error" });
process.channel?.unref();

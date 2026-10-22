const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  packSecrets,
  parseEnvironment,
  request,
} = require("./api-worker-preview.cjs");

test("encrypted environment chunks preserve multibyte values and stay below the per-secret limit", () => {
  const runtime = { ENV: "preview", KEY: "🔐中".repeat(3000), EMPTY: "" };
  const secrets = packSecrets(runtime);
  const count = Number(secrets.API_ENV_JSON_PARTS);
  assert.ok(count > 1);
  const joined = Array.from({ length: count }, (_, index) => {
    const part = secrets[`API_ENV_JSON_${index}`];
    assert.ok(Buffer.byteLength(part) <= 4096);
    return part;
  }).join("");
  assert.deepEqual(JSON.parse(joined), runtime);
  // Simulate retained old Cloudflare secrets after the runtime shrinks.
  Object.assign(secrets, packSecrets({ ENV: "preview" }));
  assert.equal(secrets.API_ENV_JSON_PARTS, "1");
  assert.deepEqual(JSON.parse(secrets.API_ENV_JSON_0), { ENV: "preview" });
});

test("resolver literal environment records preserve multiline credentials and equals signs", () => {
  const values = parseEnvironment(
    "ENV=preview\nPRIVATE_KEY=-----BEGIN KEY-----\nsecret==\n-----END KEY-----\nTOKEN=a=b=c\nEMPTY=\n",
  );
  assert.deepEqual(values, {
    ENV: "preview",
    PRIVATE_KEY: "-----BEGIN KEY-----\nsecret==\n-----END KEY-----",
    TOKEN: "a=b=c",
    EMPTY: "",
  });
});

test("control-plane failures never expose provider response bodies or native credential-bearing errors", async (t) => {
  const secret = "postgres://secret:password@database";
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(secret, { status: 400 }),
  );
  await assert.rejects(
    request(
      "https://example.invalid",
      secret,
      "POST",
      `/configs?token=${secret}`,
      {
        password: secret,
      },
    ),
    (error) =>
      !error.message.includes(secret) &&
      error.message.includes("example.invalid POST /configs") &&
      error.message.includes("HTTP 400"),
  );
  globalThis.fetch = async () => {
    throw new globalThis.Error(secret);
  };
  await assert.rejects(
    request("https://example.invalid", secret, "POST", "/configs"),
    (error) =>
      !error.message.includes(secret) && error.message.includes("not retried"),
  );
});

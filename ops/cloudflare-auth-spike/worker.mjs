import assert from "node:assert/strict";
import { DecryptCommand } from "@aws-sdk/client-kms";
import { JWT } from "google-auth-library";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "../../turbo/apps/api/src/signals/services/crypto.utils.ts";
import { client } from "./kms.mjs";

function failure(error) {
  // Never publish provider response bodies, request config, tokens or keys.
  return {
    status: "FAIL",
    error: error instanceof Error ? error.name : "UnknownError",
    httpStatus:
      error?.$metadata?.httpStatusCode ?? error?.response?.status ?? null,
  };
}

async function google(env) {
  if (
    !env.GCP_SERVICE_ACCOUNT_JSON ||
    !env.GCP_PROJECT ||
    !env.GCP_SERVICE_ACCOUNT_EMAIL
  ) {
    return {
      status: "BLOCKED",
      reason:
        "Dedicated CF_SPIKE_GCP_SERVICE_ACCOUNT_JSON and identity allowlist variables are not configured",
    };
  }
  try {
    const key = JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON);
    assert.equal(key.type, "service_account");
    assert.equal(key.project_id, env.GCP_PROJECT);
    assert.equal(key.client_email, env.GCP_SERVICE_ACCOUNT_EMAIL);
    const auth = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const token = await auth.authorize();
    assert.ok(token.access_token);
    const response = await fetch(
      `https://us-aiplatform.googleapis.com/v1/projects/${env.GCP_PROJECT}/locations/us/publishers/google/models/gemini-3.1-flash-lite:generateContent`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply OK" }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    await response.body?.cancel();
    assert.equal(response.status, 200);
    return {
      status: "PASS",
      tokenExchange: true,
      vertexHttpStatus: response.status,
    };
  } catch (error) {
    return failure(error);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return Response.json({ previewOnly: true, sha: env.SOURCE_SHA });
    }
    if (
      request.method !== "POST" ||
      !env.PROBE_AUTH ||
      request.headers.get("authorization") !== `Bearer ${env.PROBE_AUTH}`
    ) {
      return new Response("Not found", { status: 404 });
    }
    const body = await request.text();
    if (Buffer.byteLength(body) > 16_384)
      return new Response("Too large", { status: 413 });
    const fixture = JSON.parse(body);
    if (!client || !env.RESOLVED_KEY_ID) {
      return Response.json(
        {
          sha: env.SOURCE_SHA,
          version: env.VERSION.id,
          checks: [
            {
              name: "kms-runtime",
              status: "BLOCKED",
              reason: "Dedicated KMS credentials are not configured",
            },
          ],
          google: await google(env),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (
      !fixture.envelope ||
      Object.keys(fixture).some(
        (name) => !["envelope", "direct"].includes(name),
      )
    ) {
      return new Response("Invalid fixture", { status: 400 });
    }
    const checks = [];
    for (const [name, ciphertext] of Object.entries(fixture)) {
      try {
        const envelope = JSON.parse(
          Buffer.from(
            ciphertext.slice("vm0secret:v1:".length),
            "base64url",
          ).toString(),
        );
        assert.equal(envelope.kms.keyId, env.RESOLVED_KEY_ID);
        assert.equal(await decryptStoredSecretValue(ciphertext), env.CANARY);
        checks.push({ name: `node-to-worker-${name}`, status: "PASS" });
      } catch (error) {
        checks.push({ name: `node-to-worker-${name}`, ...failure(error) });
      }
    }
    let ciphertext;
    try {
      ciphertext = await encryptStoredSecretValue(env.CANARY);
      assert.equal(await decryptStoredSecretValue(ciphertext), env.CANARY);
      checks.push({ name: "worker-write-and-read", status: "PASS" });
      const envelope = JSON.parse(
        Buffer.from(
          ciphertext.slice("vm0secret:v1:".length),
          "base64url",
        ).toString(),
      );
      try {
        await client.send(
          new DecryptCommand({
            KeyId: env.RESOLVED_KEY_ID,
            CiphertextBlob: Buffer.from(
              envelope.kms.encryptedDataKey,
              "base64",
            ),
            EncryptionContext: { purpose: "wrong-spike-context" },
          }),
        );
        checks.push({ name: "wrong-context-rejected", status: "FAIL" });
      } catch (error) {
        checks.push({
          name: "wrong-context-rejected",
          status:
            error?.name === "InvalidCiphertextException" ? "PASS" : "FAIL",
        });
      }
      const tag = Buffer.from(envelope.kms.authTag, "base64");
      tag[0] ^= 1;
      envelope.kms.authTag = tag.toString("base64");
      const tampered = `vm0secret:v1:${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
      let rejected = false;
      try {
        await decryptStoredSecretValue(tampered);
      } catch (error) {
        rejected = error instanceof Error && /authenticat/i.test(error.message);
      }
      checks.push({
        name: "tampered-gcm-rejected",
        status: rejected ? "PASS" : "FAIL",
      });
    } catch (error) {
      checks.push({ name: "worker-write-and-read", ...failure(error) });
    }
    return Response.json(
      {
        sha: env.SOURCE_SHA,
        version: env.VERSION.id,
        checks,
        google: await google(env),
        ciphertext,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
};

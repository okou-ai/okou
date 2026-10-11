import { randomBytes } from "node:crypto";

import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";
import { z } from "zod";

import { stubTestAwsKmsEnvironment } from "../../../../__tests__/env-stub";
import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
} from "../../../../lib/secret-kms-client";
import { server } from "../../../../mocks/server";

const KEY_ID =
  "arn:aws:kms:us-west-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const encryptionContext = z
  .object({ purpose: z.literal("vm0-stored-secret") })
  .strict();
const generateRequest = z
  .object({
    KeyId: z.literal("alias/okou-secrets-test"),
    KeySpec: z.literal("AES_256"),
    EncryptionContext: encryptionContext,
  })
  .strict();
const decryptRequest = z
  .object({
    KeyId: z.literal(KEY_ID),
    CiphertextBlob: z.string().min(1),
    EncryptionContext: encryptionContext,
  })
  .strict();

function kmsResponse(body: Record<string, string>, status = 200) {
  return HttpResponse.json(body, {
    status,
    headers: { "content-type": "application/x-amz-json-1.1" },
  });
}

/** Register before the actor so its requests and teardown retain this boundary. */
export function mockSecretKmsHttp(): void {
  const previousClient = getSecretKmsClient();
  const previousHandlers = server.listHandlers();
  const restoreEnvironment = stubTestAwsKmsEnvironment();
  const dataKeys = new Map<string, string>();
  onTestFinished(() => {
    server.resetHandlers(...previousHandlers);
    setSecretKmsClientForTests(previousClient);
    restoreEnvironment();
    dataKeys.clear();
  });
  setSecretKmsClientForTests(undefined);
  server.use(
    http.post("https://kms.us-west-2.amazonaws.com/", async ({ request }) => {
      const authorization = request.headers.get("authorization") ?? "";
      if (
        request.headers.get("content-type") !== "application/x-amz-json-1.1" ||
        !authorization.startsWith(
          "AWS4-HMAC-SHA256 Credential=kms-http-test-access-key/",
        ) ||
        !authorization.includes("/us-west-2/kms/aws4_request,")
      ) {
        return kmsResponse({ __type: "InvalidSignatureException" }, 400);
      }
      const body: unknown = await request.json();
      const target = request.headers.get("x-amz-target");
      if (target === "TrentService.GenerateDataKey") {
        if (!generateRequest.safeParse(body).success) {
          return kmsResponse({ __type: "ValidationException" }, 400);
        }
        const plaintext = randomBytes(32).toString("base64");
        const ciphertext = randomBytes(48).toString("base64");
        dataKeys.set(ciphertext, plaintext);
        return kmsResponse({
          KeyId: KEY_ID,
          Plaintext: plaintext,
          CiphertextBlob: ciphertext,
        });
      }
      if (target === "TrentService.Decrypt") {
        const parsed = decryptRequest.safeParse(body);
        if (!parsed.success) {
          return kmsResponse({ __type: "ValidationException" }, 400);
        }
        const plaintext = dataKeys.get(parsed.data.CiphertextBlob);
        if (!plaintext) {
          return kmsResponse({ __type: "InvalidCiphertextException" }, 400);
        }
        return kmsResponse({
          KeyId: KEY_ID,
          Plaintext: plaintext,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        });
      }
      return kmsResponse({ __type: "UnknownOperationException" }, 400);
    }),
  );
}

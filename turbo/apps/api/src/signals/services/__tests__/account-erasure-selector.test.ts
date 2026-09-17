import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";

import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "../account-erasure-selector";

// Explicit external-behavior exception: this dormant B1 codec has no production
// endpoint. The actual persistent-secret/KMS implementation runs with the shared
// test setup's external KMS client; no internal encryption function is mocked.
testContext();

describe("account erasure selector envelope", () => {
  it("round-trips bounded locators using persistent KMS encryption", async () => {
    const input = {
      version: 1,
      kind: "object",
      storageRef: randomUUID(),
      key: `private/${randomUUID()}/object`,
      versionId: "version-2",
    };
    const encrypted = await encryptErasureSelector(input);
    expect(encrypted.ciphertext).toMatch(/^vm0secret:v1:/);
    expect(encrypted.ciphertext).not.toContain(input.key);
    await expect(decryptErasureSelector(encrypted)).resolves.toStrictEqual(
      input,
    );
    await expect(encryptErasureSelector(input)).resolves.toMatchObject({
      digest: encrypted.digest,
    });
    await expect(
      decryptErasureSelector({ ...encrypted, digest: "0".repeat(64) }),
    ).rejects.toThrow("selector_digest_mismatch");
  });

  it("rejects content, unknown types and oversized selectors without echoing input", async () => {
    const privateValue = "private prompt and raw provider failure";
    const subject = {
      version: 1,
      kind: "subject",
      subjectKind: "user",
      subjectId: "synthetic",
    };
    await expect(
      encryptErasureSelector({ ...subject, prompt: privateValue }),
    ).rejects.toThrow(/^account_erasure:invalid_selector$/);
    await expect(
      encryptErasureSelector({ kind: "provider-response", body: privateValue }),
    ).rejects.toThrow(/^account_erasure:invalid_selector$/);
    await expect(
      encryptErasureSelector({ ...subject, subjectId: "x".repeat(193) }),
    ).rejects.toThrow(/^account_erasure:invalid_selector$/);
    await expect(
      encryptErasureSelector({
        version: 1,
        kind: "cursor",
        after: "x".repeat(2049),
      }),
    ).rejects.toThrow(/^account_erasure:invalid_selector$/);
  });
});

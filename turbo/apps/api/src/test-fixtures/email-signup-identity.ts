import { randomUUID } from "node:crypto";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fnv1a } from "@okouai/core/identity-hash";
import { identityHashCollisionSuffix } from "./identity-hash-collision";

const EMAIL_DOMAIN = "example.test";
const EMAIL_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
// Match the existing email rollout audience without reusing its real mailbox.
const EMAIL_ROLLOUT_HASH = fnv1a("yuma@vm0.ai");

export function createUniqueEmailSignupAddressFixture(): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const prefix = `signup-${randomUUID()}-`;
    const suffix = identityHashCollisionSuffix({
      prefix,
      targetHash: Number.parseInt(EMAIL_ROLLOUT_HASH, 16),
      alphabet: EMAIL_ALPHABET,
      rightLength: 4,
      suffix: `@${EMAIL_DOMAIN}`,
    });
    if (suffix !== null) {
      const email = `${prefix}${suffix}@${EMAIL_DOMAIN}`;
      if (
        fnv1a(email.toLowerCase()) !== EMAIL_ROLLOUT_HASH ||
        !isFeatureEnabled(FeatureSwitchKey.EmailIntegration, { email })
      ) {
        throw new Error(
          "Expected an existing Email integration rollout identity",
        );
      }
      return email;
    }
  }
  throw new Error("Failed to generate a unique email signup fixture");
}

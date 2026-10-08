import type { VncRsaAesSecurityType } from "@okouai/api-contracts/contracts/vnc-rsa-aes";

export const RSA_AES_PROFILES = {
  rsa_aes_ra2: { type: "rsa_aes_ra2", method: "rsa_aes_password" },
  rsa_aes_ra2_256: { type: "rsa_aes_ra2_256", method: "rsa_aes_password" },
  rsa_aes_ra2ne: { type: "rsa_aes_ra2ne", method: "rsa_aes_password" },
  rsa_aes_ra2ne_256: { type: "rsa_aes_ra2ne_256", method: "rsa_aes_password" },
  rsa_aes_ra2_username_password: {
    type: "rsa_aes_ra2",
    method: "rsa_aes_username_password",
  },
  rsa_aes_ra2_256_username_password: {
    type: "rsa_aes_ra2_256",
    method: "rsa_aes_username_password",
  },
  rsa_aes_ra2ne_username_password: {
    type: "rsa_aes_ra2ne",
    method: "rsa_aes_username_password",
  },
  rsa_aes_ra2ne_256_username_password: {
    type: "rsa_aes_ra2ne_256",
    method: "rsa_aes_username_password",
  },
} as const;
export type RsaAesProfile = keyof typeof RSA_AES_PROFILES;
export function isRsaAesProfile(value: unknown): value is RsaAesProfile {
  return typeof value === "string" && Object.hasOwn(RSA_AES_PROFILES, value);
}
export function rsaAesProfile(
  type: VncRsaAesSecurityType,
  method: "rsa_aes_password" | "rsa_aes_username_password",
): RsaAesProfile {
  switch (type) {
    case "rsa_aes_ra2": {
      return method === "rsa_aes_password"
        ? type
        : "rsa_aes_ra2_username_password";
    }
    case "rsa_aes_ra2_256": {
      return method === "rsa_aes_password"
        ? type
        : "rsa_aes_ra2_256_username_password";
    }
    case "rsa_aes_ra2ne": {
      return method === "rsa_aes_password"
        ? type
        : "rsa_aes_ra2ne_username_password";
    }
    case "rsa_aes_ra2ne_256": {
      return method === "rsa_aes_password"
        ? type
        : "rsa_aes_ra2ne_256_username_password";
    }
  }
}

import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import { z } from "zod";
import { now } from "../../lib/time";
import { safeSync, safeJsonParse } from "../utils";
import {
  VNC_CLIENT_CHAIN_PEM_MAX_LENGTH,
  VNC_CLIENT_KEY_PEM_MAX_LENGTH,
} from "@okouai/api-contracts/contracts/vnc-credentials";

// Both the owner and private Runner handoff carry encoded DER, not PEM paths.
const wireIdentitySchema = z
  .object({
    certificateChainDer: z.array(z.base64()).min(1).max(8),
    privateKeyPkcs8Der: z.base64(),
  })
  .strict();
export type VncClientIdentityWire = z.infer<typeof wireIdentitySchema>;

function parsePemBlocks(
  value: string,
  label: "CERTIFICATE" | "PRIVATE KEY",
  max: number,
): Buffer[] {
  if (value.length > max) {
    throw new Error("Invalid VNC client certificate identity");
  }
  const expression = new RegExp(
    `-----BEGIN ${label}-----\\s*([A-Za-z0-9+/=\\s]+?)\\s*-----END ${label}-----`,
    "gu",
  );
  const blocks: Buffer[] = [];
  let cursor = 0;
  for (const match of value.matchAll(expression)) {
    if (
      match.index === undefined ||
      value.slice(cursor, match.index).trim() !== ""
    ) {
      throw new Error("Invalid VNC client certificate identity");
    }
    const encoded = match[1]?.replace(/\s/gu, "") ?? "";
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.length === 0 ||
      encoded !== bytes.toString("base64") ||
      blocks.length === 8
    ) {
      throw new Error("Invalid VNC client certificate identity");
    }
    blocks.push(bytes);
    cursor = match.index + match[0].length;
  }
  if (!blocks.length || value.slice(cursor).trim() !== "") {
    throw new Error("Invalid VNC client certificate identity");
  }
  return blocks;
}

/** Validate the leaf's date and key at write time. QEMU independently decides admission. */
export function parseVncClientIdentity(
  certificateChain: string,
  privateKey: string,
): VncClientIdentityWire {
  const result = safeSync(() => {
    return parseVncClientIdentityUnsafe(certificateChain, privateKey);
  });
  if (!("ok" in result)) {
    // Never propagate crypto/OpenSSL input or diagnostics into API responses.
    throw new Error("Invalid VNC client certificate identity");
  }
  return result.ok;
}

function parseVncClientIdentityUnsafe(
  certificateChain: string,
  privateKey: string,
): VncClientIdentityWire {
  const certificates = parsePemBlocks(
    certificateChain,
    "CERTIFICATE",
    VNC_CLIENT_CHAIN_PEM_MAX_LENGTH,
  );
  const keys = parsePemBlocks(
    privateKey,
    "PRIVATE KEY",
    VNC_CLIENT_KEY_PEM_MAX_LENGTH,
  );
  const [key] = keys;
  if (
    !key ||
    certificates.reduce((total, cert) => {
      return total + cert.length;
    }, 0) > 65_536 ||
    key.length > 16_384 ||
    keys.length !== 1
  ) {
    throw new Error("Invalid VNC client certificate identity");
  }
  const leaf = new X509Certificate(certificates[0]!);
  // A pasted chain must consist entirely of parseable X.509 certificates.
  for (const certificate of certificates) {
    new X509Certificate(certificate);
  }
  const currentTime = now();
  if (
    Date.parse(leaf.validFrom) > currentTime ||
    Date.parse(leaf.validTo) <= currentTime
  ) {
    throw new Error("Invalid VNC client certificate identity");
  }
  const parsedKey = createPrivateKey({ key, format: "der", type: "pkcs8" });
  const expected = leaf.publicKey.export({ format: "der", type: "spki" });
  const actual = createPublicKey(parsedKey).export({
    format: "der",
    type: "spki",
  });
  if (
    !Buffer.isBuffer(expected) ||
    !Buffer.isBuffer(actual) ||
    !expected.equals(actual)
  ) {
    throw new Error("Invalid VNC client certificate identity");
  }
  return {
    certificateChainDer: certificates.map((certificate) => {
      return certificate.toString("base64");
    }),
    privateKeyPkcs8Der: key.toString("base64"),
  };
}

export function parseStoredVncClientIdentity(
  value: string,
): VncClientIdentityWire {
  const decoded = wireIdentitySchema.parse(safeJsonParse(value));
  const certificates = decoded.certificateChainDer.map((encoded) => {
    return Buffer.from(encoded, "base64");
  });
  const key = Buffer.from(decoded.privateKeyPkcs8Der, "base64");
  if (
    certificates.reduce((total, cert) => {
      return total + cert.length;
    }, 0) > 65_536 ||
    key.length > 16_384 ||
    key.length === 0
  ) {
    throw new Error("Invalid stored VNC client certificate identity");
  }
  return decoded;
}

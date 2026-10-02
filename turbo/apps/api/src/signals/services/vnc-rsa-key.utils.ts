import { createHash, createPublicKey } from "node:crypto";
import { VNC_RSA_PUBLIC_KEY_MAX_BYTES } from "@okouai/api-contracts/contracts/vnc-rsa-aes";

/** Converts supplied public material only. Parsing never establishes server identity. */
export function inspectVncRsaPublicKey(publicKeyPem: string): {
  readonly serverKeySha256: string;
  readonly modulusBits: 2048 | 3072 | 4096;
} {
  if (Buffer.byteLength(publicKeyPem, "utf8") > VNC_RSA_PUBLIC_KEY_MAX_BYTES) {
    throw new Error("Invalid RSA public key");
  }
  const match =
    /^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\s+([A-Za-z0-9+/=\r\n]+)\s+-----END \1-----$/u.exec(
      publicKeyPem.trim(),
    );
  if (!match || match[2] === undefined) {
    throw new Error("Invalid RSA public key");
  }
  const encoded = match[2].replace(/[\r\n]/gu, "");
  const der = Buffer.from(encoded, "base64");
  const type = match[1] === "PUBLIC KEY" ? "spki" : "pkcs1";
  const key = createPublicKey({ key: der, format: "der", type });
  if (key.asymmetricKeyType !== "rsa" || der.toString("base64") !== encoded) {
    throw new Error("Invalid RSA public key");
  }
  // Canonical RSA SPKI ends in its PKCS#1 public sequence. Compare that exact
  // suffix rather than exporting PKCS#1 from a DER-imported provider key, which
  // some OpenSSL providers cannot encode. Extra/noncanonical DER cannot match.
  const canonical = key.export({ format: "der", type: "spki" });
  const canonicalInput =
    type === "spki"
      ? canonical
      : canonical.subarray(canonical.length - der.length);
  if (
    !der.equals(canonicalInput) ||
    (type === "pkcs1" && canonical.length <= der.length)
  ) {
    throw new Error("Invalid RSA public key");
  }
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (bits !== 2048 && bits !== 3072 && bits !== 4096) {
    throw new Error("Invalid RSA public key");
  }
  const jwk = key.export({ format: "jwk" });
  if (jwk.n === undefined || jwk.e === undefined) {
    throw new Error("Invalid RSA public key");
  }
  const modulus = Buffer.from(jwk.n, "base64url");
  const exponent = Buffer.from(jwk.e, "base64url");
  const width = bits / 8;
  if (
    modulus.length !== width ||
    (modulus[0]! & 0x80) === 0 ||
    (modulus[width - 1]! & 1) === 0 ||
    !exponent.equals(Buffer.from([1, 0, 1]))
  ) {
    throw new Error("Invalid RSA public key");
  }
  const wire = Buffer.alloc(4 + 2 * width);
  wire.writeUInt32BE(bits, 0);
  modulus.copy(wire, 4);
  exponent.copy(wire, wire.length - exponent.length);
  return {
    serverKeySha256: createHash("sha256").update(wire).digest("hex"),
    modulusBits: bits,
  };
}

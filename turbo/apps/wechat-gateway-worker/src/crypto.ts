import { Buffer } from "node:buffer";
import type { EncryptedValue } from "./types";
async function key(secret: string) {
  if (!secret || secret.length < 32) {
    throw new Error("WeChat receiver encryption key is not configured");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("okou-wechat-receiver-v1"),
      info: new TextEncoder().encode("encrypted-transport-state"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(
  secret: string,
  connectionId: string,
  value: unknown,
): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(connectionId),
    },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    iv: Buffer.from(iv).toString("base64"),
    data: Buffer.from(data).toString("base64"),
  };
}
export async function unseal(
  secret: string,
  connectionId: string,
  value: EncryptedValue,
): Promise<unknown> {
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(value.iv, "base64"),
      additionalData: new TextEncoder().encode(connectionId),
    },
    await key(secret),
    Buffer.from(value.data, "base64"),
  );
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

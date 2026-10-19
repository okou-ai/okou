export async function signature(secret: string, text: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return Array.from(new Uint8Array(signed))
    .map((byte) => {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
}
export async function controlAuthorized(request: Request, secret: string) {
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  // Compare fixed-size digests rather than a prefix-sensitive secret string.
  const expected = await signature(secret, "control");
  const actual = await signature(header.slice(7), "control");
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

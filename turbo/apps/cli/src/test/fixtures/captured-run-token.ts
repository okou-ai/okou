/** A legacy Run snapshot; mode is captured by the token, not a live member flag. */
export function capturedRunToken(capabilities: readonly string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      scope: "okou",
      userId: "test-user",
      orgId: "test-org",
      runId: "test-run",
      capabilities,
      iat: 0,
      exp: 4_102_444_800,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

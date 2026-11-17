/** Transfer canonical bytes without exposing Slack's upload capability to a client. */
export async function uploadSlackFileBytes(
  uploadUrl: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(uploadUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.pathname.startsWith("/upload/v1/")
  ) {
    throw new Error("Slack returned an unsupported file upload destination");
  }
  const response = await fetch(url, {
    method: "POST",
    body: new Uint8Array(bytes),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Slack file byte upload failed (HTTP ${response.status})`);
  }
}

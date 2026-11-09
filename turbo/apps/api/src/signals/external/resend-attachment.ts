import { accept } from "@okouai/connectors/accept";
import { object, string, url, uuid } from "zod";
import { env } from "../../lib/env";

/** Resolve fresh provider download URLs; never fetch an email-supplied URL. */
export async function fetchResendAttachment(
  emailId: string,
  attachmentId: string,
  signal: AbortSignal,
): Promise<Response> {
  const email = uuid().parse(emailId);
  const attachment = uuid().parse(attachmentId);
  const metadata = await accept(
    fetch(
      `https://api.resend.com/emails/receiving/${email}/attachments/${attachment}`,
      {
        headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}` },
        signal,
      },
    ),
    [200],
  );
  const value = object({ id: string(), download_url: url() }).parse(
    await metadata.json(),
  );
  const download = new URL(value.download_url);
  if (
    value.id !== attachment ||
    download.protocol !== "https:" ||
    download.username ||
    download.password ||
    download.port ||
    !(
      download.hostname.endsWith(".amazonaws.com") ||
      download.hostname.endsWith(".resend.com")
    )
  ) {
    throw new Error("Resend returned an invalid attachment download URL");
  }
  return await accept(fetch(download, { signal, redirect: "error" }), [200]);
}

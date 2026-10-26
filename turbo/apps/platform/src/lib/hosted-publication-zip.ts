import { writeHostedPublicationZip as writeZip } from "@okouai/core/hosted-publication-zip";
import { fetchResource } from "./resource-fetch.ts";

/** App downloads keep their credential-free resource boundary. */
export function writeHostedPublicationZip(
  args: Omit<Parameters<typeof writeZip>[0], "read">,
  signal: AbortSignal,
): Promise<boolean> {
  return writeZip(
    {
      ...args,
      read: (url, signal) => {
        return fetchResource(url, { cache: "reload", mode: "cors" }, signal);
      },
    },
    signal,
  );
}

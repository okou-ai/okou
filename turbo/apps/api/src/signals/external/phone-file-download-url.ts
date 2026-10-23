import { safeUrlParse } from "../utils";

/** AgentPhone's single-message media endpoint redirects to its anonymous file URL. */
export function phoneFileDownloadUrl(value: string): string | null {
  const url = safeUrlParse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.hostname !== "api.agentphone.ai" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/v1\/messages\/[A-Za-z0-9_-]+\/media$/u.test(url.pathname)
  ) {
    return null;
  }
  return url.href;
}

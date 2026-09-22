import { appendCapturedPreviewBypassToUrl } from "./preview-bypass-cookie.ts";
import { now } from "./time.ts";

/**
 * Open a provider's install or connect URL in its own tab.
 *
 * The timestamp defeats the browser cache, which otherwise replays a spent
 * OAuth start URL, and `?prompt=` rides along so a flow that began with a
 * starting prompt can still greet the user with it.
 */
export function openFreshOAuth(url: string): void {
  const fresh = new URL(url, window.location.origin);
  const prompt = new URLSearchParams(window.location.search).get("prompt");
  if (prompt) {
    fresh.searchParams.set("prompt", prompt);
  }
  fresh.searchParams.set("_t", String(now()));
  appendCapturedPreviewBypassToUrl(fresh);
  window.open(fresh.toString(), "_blank");
}

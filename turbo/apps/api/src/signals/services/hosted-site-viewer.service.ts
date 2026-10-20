import { command } from "ccstate";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { request$ } from "../context/hono";
import { authenticateClerkSession } from "../external/clerk";

/** Only delivery endpoints accept session tokens issued on hosted-site origins. */
export const hostedSiteViewer$ = command(
  async ({ get }, origin: string, signal: AbortSignal) => {
    const parsed = new URL(origin);
    const supported = (["current", "legacy"] as const).some((layout) => {
      const sample = new URL(hostedLinkOrigin(layout, "site"));
      const suffix = sample.hostname.slice("site".length);
      const label = parsed.hostname.endsWith(suffix)
        ? parsed.hostname.slice(0, -suffix.length)
        : "";
      return (
        parsed.origin === origin &&
        parsed.protocol === sample.protocol &&
        parsed.port === sample.port &&
        /^[a-z0-9][a-z0-9-]*$/u.test(label)
      );
    });
    const request = get(request$).raw;
    const bearer = request.headers.get("Authorization");
    if (!supported || !bearer?.startsWith("Bearer ")) {
      return undefined;
    }
    // Forward only the intended credential, never the API's browser cookies.
    const identity = await authenticateClerkSession(
      new Request(request.url, {
        headers: { Authorization: bearer },
        signal,
      }),
      { authorizedParties: [origin] },
    );
    signal.throwIfAborted();
    return identity.identity?.userId;
  },
);

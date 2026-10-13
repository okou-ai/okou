export interface WalletActionDescriptor {
  readonly action: "connect" | "approve" | "continue";
  readonly hostname: string;
  readonly originalUrl: string;
}

/** These cards navigate to the provider; a URL never proves approval or payment. */
export function parseWalletActionUrl(
  url: URL,
  originalUrl: string,
): WalletActionDescriptor | null {
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }

  let action: WalletActionDescriptor["action"];
  if (
    url.hostname === "login.link.com" &&
    url.pathname === "/auth" &&
    url.searchParams
      .get("scope")
      ?.split(/\s+/u)
      .includes("payment_methods.agentic")
  ) {
    action = "connect";
  } else if (url.hostname === "app.link.com") {
    // Link's wallet app also hosts payment-method updates, verification and
    // other requires_action destinations. Keep those provider-owned routes
    // navigable without guessing an action type or a completion state.
    action = /^\/(?:activity\/)?approve(?:\/|$)/u.test(url.pathname)
      ? "approve"
      : "continue";
  } else if (
    url.hostname === "hooks.stripe.com" &&
    /^\/(?:redirect\/authenticate|3d_secure_2\/hosted)(?:\/|$)/u.test(
      url.pathname,
    )
  ) {
    action = "continue";
  } else {
    return null;
  }

  return { action, hostname: url.hostname, originalUrl };
}

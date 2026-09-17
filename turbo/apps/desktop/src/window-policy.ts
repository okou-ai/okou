type WindowOpenDecision =
  | { readonly action: "allow-in-app" }
  | { readonly action: "open-external"; readonly url: string }
  | { readonly action: "deny" };

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function isAllowedAppNavigation(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  const url = parseUrl(rawUrl);
  if (!url) {
    return false;
  }
  return allowedAppOrigins.has(url.origin);
}

export function decideWindowOpen(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): WindowOpenDecision {
  const url = parseUrl(rawUrl);
  if (!url) {
    return { action: "deny" };
  }

  if (allowedAppOrigins.has(url.origin)) {
    return { action: "allow-in-app" };
  }

  if (
    EXTERNAL_PROTOCOLS.has(url.protocol) ||
    /^sms:\+[1-9]\d{7,14}$/u.test(url.href)
  ) {
    return { action: "open-external", url: url.toString() };
  }

  return { action: "deny" };
}

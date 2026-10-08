export type BrowserUpgradeTarget =
  "browser" | "chrome" | "chromium" | "ios" | "safari";

export interface BrowserUpgrade {
  readonly actionUrl: string;
  readonly target: BrowserUpgradeTarget;
}

function supportsAppleVersion(match: RegExpExecArray): boolean {
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 16 || (major === 16 && minor >= 4);
}

function browserUpgradeForUserAgent(userAgent: string): BrowserUpgrade | null {
  const iosMatch = /\b(?:iPhone|iPad|iPod)\b.*\bOS (\d+)(?:_(\d+))?/.exec(
    userAgent,
  );
  if (iosMatch) {
    return supportsAppleVersion(iosMatch)
      ? null
      : {
          actionUrl: "https://support.apple.com/HT204204",
          target: "ios",
        };
  }

  const chromiumMatch = /\bChromium\/(\d+)/.exec(userAgent);
  const chromeMatch = /\b(?:Chrome|CriOS|HeadlessChrome)\/(\d+)/.exec(
    userAgent,
  );
  if (
    (chromiumMatch || chromeMatch) &&
    !/\b(?:Edg|OPR|SamsungBrowser)\//.test(userAgent)
  ) {
    const match = chromiumMatch ?? chromeMatch;
    const target = chromiumMatch ? "chromium" : "chrome";
    if (Number(match?.[1]) >= 111) {
      return null;
    }
    return {
      actionUrl:
        target === "chromium"
          ? "https://www.chromium.org/getting-involved/download-chromium/"
          : "https://www.google.com/chrome/",
      target,
    };
  }

  const safariMatch = /\bVersion\/(\d+)(?:\.(\d+))?.*\bSafari\//.exec(
    userAgent,
  );
  if (
    safariMatch &&
    !/\b(?:Chrome|CriOS|Chromium|Edg|OPR|FxiOS)\//.test(userAgent)
  ) {
    return supportsAppleVersion(safariMatch)
      ? null
      : {
          actionUrl: "https://support.apple.com/safari",
          target: "safari",
        };
  }

  return null;
}

export function browserUpgradeRequired(): BrowserUpgrade | null {
  const versionUpgrade = browserUpgradeForUserAgent(navigator.userAgent);
  if (versionUpgrade) {
    return versionUpgrade;
  }
  if (typeof SharedWorker !== "function") {
    return {
      actionUrl: "https://www.google.com/chrome/",
      target: "browser",
    };
  }
  return null;
}

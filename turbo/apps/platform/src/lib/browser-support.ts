export type BrowserUpgradeTarget =
  "browser" | "chrome" | "chromium" | "edge" | "firefox" | "ios" | "safari";

export interface BrowserUpgrade {
  readonly actionUrl: string;
  readonly target: BrowserUpgradeTarget;
}

// Native CSS sign() sets the desktop Chromium floor. Android also needs
// SharedWorker, which Chromium first enabled there in 148. Tailwind v4 requires
// Firefox 128, and stable scrollbar gutters require Safari/iOS 18.2.
const MINIMUM_CHROMIUM_VERSION = 138;
const MINIMUM_ANDROID_CHROMIUM_VERSION = 148;
const MINIMUM_FIREFOX_VERSION = 128;

function supportsAppleVersion(match: RegExpExecArray): boolean {
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 18 || (major === 18 && minor >= 2);
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

  const firefoxMatch = /\bFirefox\/(\d+)/.exec(userAgent);
  if (firefoxMatch) {
    return Number(firefoxMatch[1]) >= MINIMUM_FIREFOX_VERSION
      ? null
      : {
          actionUrl: "https://www.mozilla.org/firefox/new/",
          target: "firefox",
        };
  }

  const isAndroid = /\bAndroid\b/.test(userAgent);
  const chromiumMatch = /\bChromium\/(\d+)/.exec(userAgent);
  const chromeMatch = /\b(?:Chrome|CriOS|HeadlessChrome)\/(\d+)/.exec(
    userAgent,
  );
  if (chromiumMatch || chromeMatch) {
    const match = chromiumMatch ?? chromeMatch;
    const minimumVersion = isAndroid
      ? MINIMUM_ANDROID_CHROMIUM_VERSION
      : MINIMUM_CHROMIUM_VERSION;
    if (Number(match?.[1]) >= minimumVersion) {
      return null;
    }

    // A Chrome token identifies the rendering engine, not necessarily the app.
    // Embedded browsers and other brands cannot update via Chrome's controls.
    if (
      /\b(?:wv|MicroMessenger)\b|\b(?:OPR|SamsungBrowser)\//.test(userAgent)
    ) {
      return {
        actionUrl: "https://www.google.com/chrome/",
        target: "browser",
      };
    }
    if (/\b(?:Edg|EdgA)\//.test(userAgent)) {
      return {
        actionUrl: "https://www.microsoft.com/edge/download",
        target: "edge",
      };
    }
    const target = chromiumMatch ? "chromium" : "chrome";
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
    !isAndroid &&
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

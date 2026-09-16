import { createRoot } from "react-dom/client";

import type {
  BrowserUpgrade,
  BrowserUpgradeTarget,
} from "../lib/browser-support.ts";
import { hideBootstrapSkeleton } from "../signals/app-skeleton.ts";
import type { AssistantName } from "../signals/branding.ts";
import { detach, Reason } from "../signals/utils.ts";

const UPGRADE_COPY = {
  browser: {
    action: "Get the latest Chrome",
    title: "Use a supported browser to continue",
  },
  chrome: {
    action: "Update Chrome",
    title: "Update Chrome to continue",
  },
  chromium: {
    action: "Update Chromium",
    title: "Update Chromium to continue",
  },
  ios: {
    action: "Update iOS",
    title: "Update iOS to continue",
  },
  safari: {
    action: "Update Safari",
    title: "Update Safari to continue",
  },
} as const satisfies Record<
  BrowserUpgradeTarget,
  { readonly action: string; readonly title: string }
>;

function UnsupportedBrowserPage({
  assistantName,
  upgrade,
}: {
  readonly assistantName: AssistantName;
  readonly upgrade: BrowserUpgrade;
}) {
  const copy = UPGRADE_COPY[upgrade.target];

  return (
    <div
      className="relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-background p-6 text-foreground"
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,hsl(var(--muted)/0.9),transparent_50%)]" />
      <div className="relative flex w-full max-w-96 flex-col items-center gap-6 rounded-2xl border border-border bg-card p-8 text-center shadow-sm max-sm:px-5 max-sm:py-6">
        <div
          className="flex size-10 items-center justify-center rounded-[10px] bg-primary/10"
          aria-hidden="true"
        >
          <svg viewBox="0 0 40 40" className="size-10">
            <path
              d="M13 20a7 7 0 0 1 12-5M27 20a7 7 0 0 1-12 5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2.5"
              className="text-brand-text"
            />
            <path
              d="m24 11 1 4-4 1M16 29l-1-4 4-1"
              fill="currentColor"
              className="text-brand-text"
            />
          </svg>
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-base leading-6 font-semibold">{copy.title}</h1>
          <p className="text-sm leading-[22px] text-muted-foreground">
            {assistantName}
            {upgrade.target === "browser"
              ? " does not support this browser on your device. Update your browser, or try another browser or device."
              : " does not support your current browser version. Update your browser to continue."}
          </p>
        </div>
        <a
          href={upgrade.actionUrl}
          className="inline-flex min-h-10 w-full items-center justify-center rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {copy.action}
        </a>
      </div>
    </div>
  );
}

export function renderUnsupportedBrowserPage(
  rootElement: HTMLElement,
  assistantName: AssistantName,
  upgrade: BrowserUpgrade,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  const root = createRoot(rootElement);
  signal.addEventListener(
    "abort",
    () => {
      root.unmount();
    },
    { once: true },
  );
  root.render(
    <UnsupportedBrowserPage assistantName={assistantName} upgrade={upgrade} />,
  );
  detach(
    hideBootstrapSkeleton(),
    Reason.Entrance,
    "unsupported browser bootstrap skeleton",
  );
}

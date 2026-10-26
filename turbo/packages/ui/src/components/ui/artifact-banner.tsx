import * as React from "react";
import {
  ArrowUpRight,
  CircleCheck,
  CircleX,
  Download,
  Maximize2,
  Share2,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";

/** Presentation only: identities, permissions and actions belong to the caller. */
export function ArtifactBanner({
  title,
  subtitle,
  homeUrl,
  brandName,
  brandMark,
  titleAs = "h1",
  hidden = false,
  children,
}: {
  readonly title: string;
  readonly subtitle?: React.ReactNode;
  readonly homeUrl: string;
  readonly brandName: string;
  readonly brandMark: React.ReactNode;
  readonly titleAs?: "h1" | "p";
  readonly hidden?: boolean;
  readonly children: React.ReactNode;
}) {
  const Title = titleAs;
  return (
    <header
      hidden={hidden}
      className={cn(
        "relative z-10 h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background px-3 text-foreground sm:gap-4 sm:px-6",
        hidden ? "hidden" : "flex",
      )}
    >
      <a
        href={homeUrl}
        aria-label={brandName}
        className="shrink-0 text-foreground hover:opacity-70 focus:not-focus-visible:outline-none"
        referrerPolicy="no-referrer"
      >
        {brandMark}
      </a>
      <div className="min-w-0 flex-1">
        <Title
          data-slot="artifact-banner-title"
          className="truncate text-sm font-medium"
        >
          {title}
        </Title>
        {subtitle !== undefined && (
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {children}
    </header>
  );
}

/** Small native actions that can run on a publisher origin without App state. */
export function HostedSiteBannerActions({
  continueUrl,
}: {
  readonly continueUrl: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        data-okou-banner-share=""
        aria-label="Share"
        className={buttonVariants({ variant: "quiet", size: "icon-sm" })}
      >
        <Share2 size={16} aria-hidden />
      </button>
      <button
        type="button"
        data-okou-banner-download=""
        aria-label="Download"
        className={buttonVariants({ variant: "quiet", size: "icon-sm" })}
      >
        <Download size={16} aria-hidden />
      </button>
      <button
        type="button"
        data-okou-banner-fullscreen=""
        aria-label="Enter fullscreen"
        className={buttonVariants({ variant: "quiet", size: "icon-sm" })}
      >
        <Maximize2 size={16} aria-hidden />
      </button>
      <span className="mx-1 h-4 border-l border-border" aria-hidden />
      <a
        href={continueUrl}
        referrerPolicy="no-referrer"
        aria-label="Continue with Okou"
        className={cn(
          buttonVariants({ size: "sm" }),
          "ml-1 h-8 w-8 p-0 sm:ml-2 sm:w-auto sm:px-3",
        )}
      >
        <span className="hidden sm:inline">Continue with Okou</span>
        <ArrowUpRight size={16} className="sm:hidden" aria-hidden />
      </a>
      <span
        role="status"
        aria-atomic="true"
        hidden
        data-okou-banner-status=""
        className="group font-family-sans pointer-events-none fixed inset-x-0 top-6 z-50 mx-auto flex w-max max-w-[calc(100vw-2rem)] items-center gap-2 rounded-xl border border-solid border-border bg-popover px-4 py-4 text-sm font-medium text-popover-foreground [box-shadow:0_4px_12px_#0000001a]"
      >
        <CircleCheck
          size={20}
          aria-hidden
          className="shrink-0 text-green-600 group-data-[error]:hidden"
        />
        <CircleX
          size={20}
          aria-hidden
          className="hidden shrink-0 text-red-500 group-data-[error]:block"
        />
        <span data-okou-banner-message="" />
      </span>
    </div>
  );
}

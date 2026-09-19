import type { ReactNode } from "react";
import { Card, Radio, surfaceVariants, cn } from "@okouai/ui";
import { settingsIconAssetUrl } from "../okou-page/components/settings/settings-icon-assets.ts";

/** Okou's own onboarding illustrations. */
const ILLUSTRATION_BASE = "https://static.okou.io/web/assets/onboarding/";

/**
 * Illustrations keep their own aspect ratio, so a mark is sized by height and
 * capped in width. A card leads with the poster size; a row carries the same
 * art at header size.
 */
const MARK_SIZES = {
  poster: "h-[132px] max-w-[240px]",
  header: "h-9 max-w-9",
} as const;

type MarkSize = keyof typeof MARK_SIZES;

export function OnboardingIllustration({
  name,
  alt,
  size = "header",
}: {
  readonly name: "experienced" | "new" | "skill-import";
  readonly alt: string;
  readonly size?: MarkSize;
}) {
  return (
    <img
      src={`${ILLUSTRATION_BASE}v3-${name === "skill-import" ? "skill-import" : `choice-${name}`}-fit_480.png`}
      alt={alt}
      className={cn("shrink-0 object-contain", MARK_SIZES[size])}
    />
  );
}

/**
 * A product mark from the settings icon set. `mark` is the size a mark takes
 * inside a line of text, next to the words it belongs to.
 */
const PRODUCT_MARK_SIZES = {
  poster: "h-20 w-20",
  header: "h-7 w-7",
  mark: "h-4 w-4",
} as const;

export function ProductMark({
  name,
  alt,
  size = "header",
  invertInDarkMode = false,
}: {
  readonly name: Parameters<typeof settingsIconAssetUrl>[0];
  readonly alt: string;
  readonly size?: keyof typeof PRODUCT_MARK_SIZES;
  readonly invertInDarkMode?: boolean;
}) {
  return (
    <img
      src={settingsIconAssetUrl(name)}
      alt={alt}
      className={cn(
        "shrink-0 object-contain",
        PRODUCT_MARK_SIZES[size],
        invertInDarkMode && "dark:invert",
      )}
    />
  );
}

/**
 * A step whose answer is one of two options leads with the mark and keeps the
 * radio with the label, so the card itself is the target.
 */
export function OnboardingPosterCard({
  value,
  selected,
  mark,
  title,
  description,
}: {
  readonly value: string;
  readonly selected: boolean;
  readonly mark: ReactNode;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <label
      className={cn(
        surfaceVariants({ interactive: true }),
        "flex min-h-[340px] flex-col overflow-hidden",
        selected && "border-primary",
      )}
    >
      <span className="flex flex-1 items-center justify-center px-6 pb-8 pt-10">
        {mark}
      </span>
      <span className="block px-5 pb-5">
        <span className="flex items-center gap-3">
          <Radio value={value} />
          <span className="text-sm font-medium text-foreground">{title}</span>
        </span>
        <span className="mt-1 block pl-7 text-sm leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

/** A selectable tile, for the steps whose options are a list. */
export function OnboardingChoiceCard({
  value,
  selected,
  title,
  description,
}: {
  readonly value: string;
  readonly selected: boolean;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <label
      className={cn(
        surfaceVariants({ interactive: true }),
        "block px-4 py-3.5",
        selected && "border-primary",
      )}
    >
      {/* The control sits on the title's line, with the summary under it. */}
      <span className="flex items-center gap-3">
        <Radio value={value} />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {title}
        </span>
      </span>
      <span className="mt-0.5 block pl-7 text-xs leading-5 text-muted-foreground">
        {description}
      </span>
    </label>
  );
}

/** The panel a step acts in: a header row, then the step's own controls. */
export function OnboardingPanel({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <Card className="flex min-h-[300px] flex-col">
      <div className="px-5 py-4">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex flex-1 flex-col border-t border-border/60">
        {children}
      </div>
    </Card>
  );
}

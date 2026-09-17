import type { ReactNode } from "react";
import { Card, Radio, surfaceVariants, cn } from "@okouai/ui";
import { settingsIconAssetUrl } from "../okou-page/components/settings/settings-icon-assets.ts";

/** Okou's own onboarding illustrations, already shipped for the make step. */
const ILLUSTRATION_BASE = "https://static.okou.io/web/assets/onboarding/";

/**
 * A mark is either the size a card leads with or the size a panel header
 * carries. Nothing in onboarding needs a third size.
 */
const MARK_SIZES = {
  poster: "h-[72px] w-[72px]",
  header: "h-9 w-9",
} as const;

type MarkSize = keyof typeof MARK_SIZES;

export function OnboardingIllustration({
  name,
  alt,
  size = "header",
}: {
  readonly name: "workflow-default" | "explore";
  readonly alt: string;
  readonly size?: MarkSize;
}) {
  return (
    <img
      src={`${ILLUSTRATION_BASE}v2-choice-${name}_160x160.png`}
      alt={alt}
      className={cn("shrink-0 object-contain", MARK_SIZES[size])}
    />
  );
}

/** A product mark from the settings icon set. */
export function ProductMark({
  name,
  alt,
  size = "header",
  invertInDarkMode = false,
}: {
  readonly name: Parameters<typeof settingsIconAssetUrl>[0];
  readonly alt: string;
  readonly size?: MarkSize;
  readonly invertInDarkMode?: boolean;
}) {
  return (
    <img
      src={settingsIconAssetUrl(name)}
      alt={alt}
      className={cn(
        "shrink-0 object-contain",
        size === "poster" ? "h-14 w-14" : "h-7 w-7",
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
        "flex min-h-[300px] flex-col overflow-hidden",
        selected && "border-primary",
      )}
    >
      <span className="flex flex-1 items-center justify-center px-6 pb-8 pt-10">
        {mark}
      </span>
      <span className="flex items-start gap-3 px-5 pb-5">
        <Radio value={value} className="mt-0.5" />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            {title}
          </span>
          <span className="mt-1 block text-sm leading-5 text-muted-foreground">
            {description}
          </span>
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
        "flex items-start gap-3 px-4 py-3.5",
        selected && "border-primary",
      )}
    >
      <Radio value={value} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

/** The panel a step acts in: a header row, then the step's own controls. */
export function OnboardingPanel({
  mark,
  title,
  description,
  children,
}: {
  readonly mark: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-center gap-3 px-5 py-4">
        {mark}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            {title}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            {description}
          </span>
        </span>
      </div>
      <div className="border-t border-border/60">{children}</div>
    </Card>
  );
}

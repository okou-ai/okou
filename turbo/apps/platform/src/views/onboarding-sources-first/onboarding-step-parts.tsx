import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Card, Radio, surfaceVariants, cn } from "@okouai/ui";
import { settingsIconAssetUrl } from "../okou-page/components/settings/settings-icon-assets.ts";

/** Okou's own onboarding illustrations. */
export const ILLUSTRATION_BASE =
  "https://static.okou.io/web/assets/onboarding/";

/** Each illustration's published file; the guided start has no white plate. */
const ILLUSTRATION_FILES = {
  experienced: "v3-choice-experienced",
  new: "v4-choice-new",
} as const;

/**
 * Illustrations keep their own aspect ratio, so a mark is sized by height and
 * capped in width. A card leads with the poster size; a row carries the same
 * art at header size.
 */
const MARK_SIZES = {
  poster: "h-[132px] max-w-[240px]",
  // The size an answer card carries: small enough that three sit in a row
  // without the art outweighing the words under it.
  choice: "h-[96px] max-w-[176px] max-sm:h-7 max-sm:max-w-7",
  header: "h-9 max-w-9",
} as const;

type MarkSize = keyof typeof MARK_SIZES;

export function OnboardingIllustration({
  name,
  alt,
  size = "header",
}: {
  readonly name: "experienced" | "new";
  readonly alt: string;
  readonly size?: MarkSize;
}) {
  return (
    <img
      src={`${ILLUSTRATION_BASE}${ILLUSTRATION_FILES[name]}-fit_480.png`}
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
  choice: "h-14 w-14 max-sm:h-6 max-sm:w-6",
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
        // Match the sidebar's compensation for the Slack artwork's padding.
        name === "slack" && "scale-[2.2]",
        invertInDarkMode && "dark:invert",
      )}
    />
  );
}

/**
 * A step whose answer is one of a few options: the card itself is the control,
 * so it leads with the mark and the chosen one is bordered and ticked rather
 * than ticked in a circle. The surface stays the card's own: a tinted fill
 * would show through the illustrations, which carry an opaque white plate.
 * The radio stays behind it for the keyboard and screen readers.
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
        "relative flex min-h-[300px] flex-col overflow-hidden text-center",
        // A phone lists the answers as rows, so all three fit one screen.
        "max-sm:min-h-0 max-sm:flex-row max-sm:items-center max-sm:gap-3.5 max-sm:p-4 max-sm:text-left",
        selected && "border-primary",
      )}
    >
      {/* Hidden by a wrapper: the radio's own position and size utilities
          outrank `sr-only` on the control itself, which left a 16px box in
          the row. */}
      <span className="sr-only">
        <Radio value={value} />
      </span>
      {selected ? (
        <span
          className="absolute right-4 top-4 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground max-sm:static max-sm:order-last max-sm:shrink-0"
          aria-hidden="true"
        >
          <Check size={14} />
        </span>
      ) : (
        <span
          className="hidden size-6 shrink-0 rounded-full border border-control-border max-sm:order-last max-sm:block"
          aria-hidden="true"
        />
      )}
      <span className="flex flex-1 items-center justify-center px-8 pb-7 pt-12 max-sm:size-11 max-sm:flex-none max-sm:rounded-xl max-sm:bg-muted max-sm:p-0">
        {mark}
      </span>
      <span className="block px-8 pb-9 max-sm:min-w-0 max-sm:flex-1 max-sm:p-0">
        <span className="block text-sm font-medium text-foreground max-sm:text-base">
          {title}
        </span>
        <span className="mt-1 block text-sm leading-5 text-muted-foreground">
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

import { cva } from "class-variance-authority";

/**
 * Shared paint and geometry for inline references in editable and rendered text.
 * Callers retain their native link, button, or editor-node semantics, title width,
 * and icon/thumbnail. Reference glyphs use text-selected-foreground; labels keep
 * the body foreground so they also read on filled message surfaces.
 */
export const inlineReferenceVariants = cva(
  "relative -top-px mx-0.5 inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 align-middle text-[13px] font-medium text-foreground",
  {
    variants: {
      interactive: {
        true: "transition-colors hover:bg-primary/15 active:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      },
      selectable: {
        true: "data-[selected]:border-primary data-[selected]:bg-primary/15",
      },
      padding: {
        inline: "px-2",
        none: "",
      },
    },
    defaultVariants: {
      interactive: false,
      selectable: false,
      padding: "inline",
    },
  },
);

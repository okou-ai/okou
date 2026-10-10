import { cva } from "class-variance-authority";

/**
 * Shared paint and geometry for inline references in editable and rendered text.
 * Callers retain their native link, button, or editor-node semantics, title width,
 * and icon/thumbnail. Reference glyphs use text-selected-foreground; labels keep
 * the body foreground so they also read on filled message surfaces.
 *
 * The fill and hairline are translucent state layers, so a reference sits one
 * fixed step off whatever it is drawn on — the composer card, the gray-200 user
 * bubble, or the canvas behind an Agent reply. A `primary/*` fill cannot do
 * that: it inherits each palette's primary lightness, which runs from 23% to
 * 78%, so under Cotton sky it lands on the user bubble's own colour. Light takes
 * the selected-hover step because a selected-step fill is too faint on the
 * bubble; dark keeps the selected step, which already clears every dark ground.
 */
export const inlineReferenceVariants = cva(
  "relative -top-px mx-0.5 inline-flex h-7 items-center gap-1.5 rounded-md border border-state-pressed bg-state-selected-hover align-middle text-[13px] font-medium text-foreground dark:bg-state-selected",
  {
    variants: {
      interactive: {
        true: "transition-colors hover:bg-state-hover-overlay active:bg-state-pressed-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      },
      selectable: {
        true: "data-[selected]:border-primary data-[selected]:bg-state-hover-overlay",
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

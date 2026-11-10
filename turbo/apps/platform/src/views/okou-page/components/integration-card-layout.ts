import { surfaceVariants } from "@okouai/ui";

/**
 * `row` cards sit inside a shared divided surface that the page owns; `tile`
 * cards are standalone compact surfaces in a grid.
 */
const ICON_FRAME =
  "inline-flex shrink-0 items-center justify-center overflow-hidden";

export type IntegrationCardLayout = "row" | "tile";

export function integrationCardLayout(layout: IntegrationCardLayout) {
  if (layout === "row") {
    return {
      frame: "flex flex-col",
      header: "flex items-center gap-4 px-4 py-3",
      icon: "size-7",
      iconFrame: `${ICON_FRAME} size-7`,
      iconSize: 28,
      overflow: "line-clamp-2",
    };
  }
  return {
    frame: surfaceVariants({
      radius: "compact",
      className: "flex flex-col justify-center",
    }),
    header: "flex items-center gap-3 py-2.5 pr-2.5 pl-3.5",
    icon: "size-5",
    iconFrame: `${ICON_FRAME} size-5`,
    iconSize: 20,
    overflow: "line-clamp-2",
  };
}

import { cn } from "@okouai/ui";
import {
  emptyAutomationsImg,
  emptySearchImg,
  noConnectorImg,
} from "../okou-page/platform-assets.ts";

const scenes = Object.freeze({
  computer: emptyAutomationsImg,
  search: emptySearchImg,
  connection: noConnectorImg,
});

const sizes = Object.freeze({
  page: "h-24 w-36",
  panel: "h-16 w-24",
});

/** Artwork for initial setup and browser blanks; other states keep their existing UI. */
export function EmptyStateIllustration({
  scene,
  size = "page",
  className,
}: {
  readonly scene: keyof typeof scenes;
  readonly size?: keyof typeof sizes;
  readonly className?: string;
}) {
  return (
    <img
      src={scenes[scene]}
      alt=""
      role="presentation"
      loading="lazy"
      data-slot="empty-state-illustration"
      data-scene={scene}
      className={cn(
        "pointer-events-none shrink-0 object-contain",
        sizes[size],
        className,
      )}
    />
  );
}

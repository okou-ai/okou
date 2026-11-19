import { cn } from "@okouai/ui";
import {
  emptyArtifactImg,
  emptyAutomationsImg,
  emptyChatImg,
  emptySearchImg,
  emptyUsageImg,
  noConnectorImg,
  noPermissionIllustration,
} from "../okou-page/platform-assets.ts";

const scenes = Object.freeze({
  artifact: emptyArtifactImg,
  computer: emptyAutomationsImg,
  chat: emptyChatImg,
  search: emptySearchImg,
  usage: emptyUsageImg,
  connection: noConnectorImg,
  permission: noPermissionIllustration,
});

const sizes = Object.freeze({
  page: "h-24 w-36",
  panel: "h-16 w-24",
});

/** Artwork for primary empty regions; compact controls keep text or icons. */
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

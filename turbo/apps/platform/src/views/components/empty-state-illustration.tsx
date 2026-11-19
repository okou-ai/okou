import { cn } from "@okouai/ui";
import { platformEmptyPrivateAgentsImg } from "../../lib/static-assets.ts";
import {
  emptyArtifactImg,
  emptyAutomationsImg,
  emptyChatImg,
  emptyMailImg,
  emptySearchImg,
  emptyUsageImg,
  emptyWorkflowImg,
  noConnectorImg,
  noPermissionIllustration,
} from "../okou-page/platform-assets.ts";

const scenes = Object.freeze({
  agent: platformEmptyPrivateAgentsImg,
  artifact: emptyArtifactImg,
  computer: emptyAutomationsImg,
  chat: emptyChatImg,
  mail: emptyMailImg,
  search: emptySearchImg,
  usage: emptyUsageImg,
  workflow: emptyWorkflowImg,
  connection: noConnectorImg,
  permission: noPermissionIllustration,
});

const sizes = Object.freeze({
  page: "h-24 w-36",
  panel: "h-16 w-24",
  row: "h-8 w-12",
  inline: "h-6 w-9",
});

/** Decorative brand artwork; the adjacent copy owns the accessible message. */
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

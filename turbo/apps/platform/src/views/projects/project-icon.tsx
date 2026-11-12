import { Folder, FolderOpen } from "lucide-react";
import { cn } from "@okouai/ui";
import { getChatThreadTitleParts } from "../../signals/chat-page/chat-thread-title.ts";

/**
 * A Project's name carries its emoji the way a chat title does. The folder
 * wears it as a badge, so the name beside the folder shows the rest. A name
 * that is only an emoji keeps it as the name.
 */
export function projectNameParts(name: string) {
  const { emoji, text } = getChatThreadTitleParts(name);
  return emoji && text ? { emoji, text } : { emoji: null, text: name };
}

/**
 * A Project's folder, wearing its name's emoji on the lower right corner. The
 * folder is cut away around the badge so the gap holds on any background. The
 * badge reaches 3px past the folder, so the icon keeps a 16px icon's footprint
 * wherever it stands.
 */
export function ProjectFolderIcon({
  name,
  open = false,
  className,
  folderClassName,
}: {
  readonly name: string;
  readonly open?: boolean;
  readonly className?: string;
  readonly folderClassName?: string;
}) {
  const { emoji } = projectNameParts(name);
  const Icon = open ? FolderOpen : Folder;
  return (
    <span
      aria-hidden="true"
      className={cn("relative flex size-4 shrink-0", className)}
    >
      <Icon
        size={16}
        className={cn(
          folderClassName,
          // A circle around the badge's centre, 13px into the folder.
          emoji &&
            "[mask-image:radial-gradient(circle_at_13px_13px,transparent_7.25px,#000_7.75px)]",
        )}
      />
      {emoji && (
        <span className="absolute -bottom-[3px] -right-[3px] flex size-3 items-center justify-center font-family-emoji text-xs leading-none">
          {emoji}
        </span>
      )}
    </span>
  );
}

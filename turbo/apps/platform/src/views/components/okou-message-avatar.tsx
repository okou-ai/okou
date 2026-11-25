import {
  okouMessageAvatarStill,
  okouMessageAvatarAnimated,
} from "../../lib/static-assets.ts";
import { cn } from "@okouai/ui";

export function OkouMessageAvatar({
  animated,
  size,
  alt = "",
  className,
  ...attributes
}: {
  animated: boolean;
  size: number;
  alt?: string;
  className?: string;
}) {
  const portrait = (
    <img
      {...attributes}
      data-okou-avatar=""
      src={okouMessageAvatarStill}
      alt={alt}
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    />
  );
  if (!animated) {
    return portrait;
  }
  return (
    <picture className="contents">
      <source
        media="(prefers-reduced-motion: no-preference)"
        srcSet={okouMessageAvatarAnimated}
      />
      {portrait}
    </picture>
  );
}

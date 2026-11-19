import { noPermissionIllustration } from "../platform-assets.ts";

type NoPermissionIllustrationProps = {
  className?: string;
};

/**
 * Padlock illustration for restricted access / not-found states (transparent WebP).
 */
export function NoPermissionIllustration({
  className = "h-28 w-auto max-w-[200px] object-contain",
}: NoPermissionIllustrationProps) {
  return (
    <img
      src={noPermissionIllustration}
      alt=""
      role="presentation"
      loading="lazy"
      className={className}
    />
  );
}

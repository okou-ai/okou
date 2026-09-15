import { useGet } from "ccstate-react";
import { cn } from "@okouai/ui";
import {
  avatarFramingEnabled$,
  avatarNeckSweaterEnabled$,
} from "../../signals/external/feature-switch.ts";
import {
  AVATAR_ARTWORK_SLOT,
  AVATAR_HEAD_SLOT,
  avatarSvgComposition,
  avatarSvgContentTransform,
  isLegacyAvatarSvgConfig,
  type ResolvedAvatarSvgConfig,
} from "./avatar-svg-utils.ts";

interface AvatarSvgPreviewProps {
  config: ResolvedAvatarSvgConfig;
  size?: number;
  className?: string;
  centerContent?: boolean;
  /** Keep the shared chin and collar aligned with adjacent brand avatars. */
  preserveChinBaseline?: boolean;
  alt?: string;
  "data-testid"?: string;
}

/**
 * Renders a composite avatar by layering neck, head, and sweater SVG images.
 */
export function AvatarSvgPreview({
  config,
  size,
  className,
  centerContent = false,
  preserveChinBaseline = false,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  const neckSweater = useGet(avatarNeckSweaterEnabled$);
  const preserveBaseline =
    preserveChinBaseline && neckSweater && !isLegacyAvatarSvgConfig(config);
  const framing = useGet(avatarFramingEnabled$) && !preserveBaseline;
  const { behind, head, front, headOffsetY, contentOffsetY, contentScale } =
    avatarSvgComposition(config, { neckSweater, framing });
  // `centerContent` is the avatar maker asking for centering on its own while
  // the framing switch is off. Pinned rows keep the shared chin baseline instead
  // of letting hair height move each collar to a different position.
  const transform = avatarSvgContentTransform({
    contentOffsetY:
      !preserveBaseline && (framing || centerContent) ? contentOffsetY : 0,
    contentScale,
  });
  const layerClassName = "absolute inset-0 h-full w-full object-cover";
  const layer = (src: string) => {
    return <img key={src} alt="" src={src} className={layerClassName} />;
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden",
        className,
        // Keep collars and tall hair intact when the shared chin baseline puts
        // the top of a hairstyle just beyond the composition canvas.
        preserveBaseline && "overflow-visible rounded-none",
      )}
      style={size ? { width: size, height: size } : undefined}
      {...(alt ? { role: "img", "aria-label": alt } : undefined)}
      data-testid={testId}
    >
      <div
        {...AVATAR_ARTWORK_SLOT}
        className="absolute inset-0"
        style={transform ? { transform } : undefined}
      >
        {behind.map(layer)}
        <div
          {...AVATAR_HEAD_SLOT}
          className="absolute inset-0"
          style={{
            transform: `translateY(${headOffsetY}%)`,
          }}
        >
          {head.map(layer)}
        </div>
        {front.map(layer)}
      </div>
    </div>
  );
}

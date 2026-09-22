import { useGet } from "ccstate-react";
import { cn } from "@okouai/ui";
import {
  avatarFramingEnabled$,
  avatarNeckSweaterEnabled$,
} from "../../signals/external/feature-switch.ts";
import {
  AVATAR_ARTWORK_SLOT,
  AVATAR_HEAD_SLOT,
  AVATAR_TEXTURE_SLOT,
  avatarSvgComposition,
  avatarSvgContentTransform,
  isLegacyAvatarSvgConfig,
  type ResolvedAvatarSvgConfig,
} from "./avatar-svg-utils.ts";

/**
 * The brand texture, behind whichever artwork its frame holds.
 *
 * Shared by the layered composer avatar and by the drawn files that are not
 * composed at all, so the two cannot drift on the one value that matters here:
 * the tile is 328px of artwork and the frame renders it at 56px, so at 100% a
 * brush mark is 4.4px and reads as noise rather than as a stroke. 180% shows
 * two or three marks per frame.
 */
export function AvatarTextureLayer({ url }: { url: string }) {
  return (
    <span
      {...AVATAR_TEXTURE_SLOT}
      aria-hidden="true"
      className="absolute inset-0 bg-[length:180%] bg-center"
      style={{ backgroundImage: `url(${url})` }}
    />
  );
}

interface AvatarSvgPreviewProps {
  config: ResolvedAvatarSvgConfig;
  size?: number;
  className?: string;
  centerContent?: boolean;
  /** Keep the shared chin and collar aligned with adjacent brand avatars. */
  preserveChinBaseline?: boolean;
  /**
   * Brand texture drawn behind the layers, and the reason the artwork is
   * bottom-anchored: the figure's lower edge is an open cut, which needs the
   * frame to carry it once anything is visible underneath.
   */
  textureUrl?: string;
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
  textureUrl,
  alt,
  "data-testid": testId,
}: AvatarSvgPreviewProps) {
  const neckSweater = useGet(avatarNeckSweaterEnabled$);
  const preserveBaseline =
    preserveChinBaseline && neckSweater && !isLegacyAvatarSvgConfig(config);
  const framing = useGet(avatarFramingEnabled$) && !preserveBaseline;
  // A texture and the bottom anchor are one decision, not two: the anchor only
  // matters because the texture makes the artwork's cut edge visible.
  const bottomAnchored = textureUrl !== undefined;
  const { behind, head, front, headOffsetY, contentOffsetY, contentScale } =
    avatarSvgComposition(config, { neckSweater, framing, bottomAnchored });
  // `centerContent` is the avatar maker asking for centering on its own while
  // the framing switch is off. Pinned rows keep the shared chin baseline instead
  // of letting hair height move each collar to a different position.
  const transform = avatarSvgContentTransform({
    contentOffsetY:
      bottomAnchored || (!preserveBaseline && (framing || centerContent))
        ? contentOffsetY
        : 0,
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
      {textureUrl ? <AvatarTextureLayer url={textureUrl} /> : null}
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

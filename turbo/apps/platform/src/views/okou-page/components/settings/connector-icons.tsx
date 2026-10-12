import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { cn } from "@okouai/ui";

/**
 * Connector mark in a square slot, driven by public catalog display data.
 *
 * The slot holds its size and stays empty until the mark can be drawn: while
 * the catalog entry is still on its way, while the image downloads, and if it
 * fails. The mark then fades in, so a slot changes once. A stand-in glyph read
 * as a wrong logo for as long as the catalog took and made every slot change
 * twice, and the caption or title beside each mark already names the
 * connector.
 */
export function ConnectorIcon({
  icon,
  size = 28,
}: {
  icon: PublicConnectorCatalogIcon | undefined;
  size?: number;
}) {
  const scaled = icon?.scale !== undefined;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        scaled && "overflow-hidden",
      )}
      style={{ width: size, height: size }}
    >
      {icon !== undefined && (
        <img
          key={icon.url}
          src={icon.url}
          alt=""
          decoding="async"
          // A browsed category is a grid of a whole catalog section, so most
          // of its marks are far below the fold. Without this the largest
          // category opens by requesting every icon it holds at once.
          loading="lazy"
          className={cn(
            "block h-full w-full max-h-full max-w-full object-contain",
            "opacity-0 data-[loaded=true]:opacity-100 motion-safe:transition-opacity motion-safe:duration-150 motion-safe:ease-out",
            icon.invertInDarkMode && "dark:invert",
          )}
          style={
            icon.scale === undefined
              ? undefined
              : { transform: `scale(${icon.scale})` }
          }
          onLoad={(event) => {
            event.currentTarget.dataset.loaded = "true";
          }}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
}

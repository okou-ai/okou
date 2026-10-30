import { workspaceLogoColorway } from "@okouai/core/workspace-logo";
import { cn } from "@okouai/ui";

import { OkouLogomark } from "./okou-logomark.tsx";

/**
 * Shared thumbnail scale for the two identity marks in the app chrome: the
 * person behind the session (`UserAvatar`) and the workspace they are in
 * (`WorkspaceLogo`). Both draw from the same size and stroke vocabulary so a
 * user avatar and a workspace logo sitting in the same column line up.
 */
const THUMBNAIL_SIZE = {
  sm: "h-6 w-6",
  md: "h-8 w-8",
  // Fills a `size="icon"` button edge to edge. The labeled navigation rail
  // hangs its marks off such a button beside 36px nav chips: at any smaller
  // step the button's hover background frames the mark in grey instead of the
  // mark simply being the button.
  "md+": "h-9 w-9",
  lg: "h-10 w-10",
  xl: "h-12 w-12",
} as const;

// Square thumbnails keep their corner radius at a constant quarter of the box,
// so a 24px logo and a 40px one read as the same shape at different scales.
// Same ratio the file-preview icon already uses (20px/5px, 40px/10px).
const THUMBNAIL_RADIUS = {
  sm: "rounded-[6px]",
  md: "rounded-[8px]",
  // The one step off the quarter ratio, which would ask for 9px here. `md+`
  // covers a `rounded-lg` button exactly, and a radius larger than the
  // button's leaves four grey slivers of it showing at the corners.
  "md+": "rounded-[8px]",
  lg: "rounded-[10px]",
  xl: "rounded-[12px]",
} as const;

const THUMBNAIL_INITIAL_TEXT = {
  sm: "text-[11px]",
  md: "text-xs",
  "md+": "text-[13px]",
  lg: "text-sm",
  xl: "text-base",
} as const;

type ThumbnailSize = keyof typeof THUMBNAIL_SIZE;

// The shared hairline every thumbnail carries so its bounds stay readable
// against the sidebar, cards, and menus alike — including avatars whose artwork
// fades out at the edge. `border` reads `--default-border-width`, which is the
// 0.5px this treatment has always drawn, and `border-surface-border` is the
// registered name for its `hsl(var(--gray-400))` stroke.
const THUMBNAIL_BASE = "shrink-0 border border-surface-border";

/**
 * A person: a circle by default, so it never reads as a workspace or an app
 * icon. The labeled navigation rail asks for `square` instead: there the
 * account mark sits directly under the workspace logo in a column of rounded
 * squares, and matching that shape is what keeps the column reading as a grid.
 * Falls back to the name's initial when the account has no picture.
 */
export function UserAvatar({
  imageUrl,
  name,
  initial,
  size = "md",
  shape = "circle",
}: {
  imageUrl: string | null | undefined;
  name: string;
  initial: string;
  size?: ThumbnailSize;
  shape?: "circle" | "square";
}) {
  const base = cn(
    THUMBNAIL_BASE,
    THUMBNAIL_SIZE[size],
    shape === "square" ? THUMBNAIL_RADIUS[size] : "rounded-full",
  );

  if (imageUrl) {
    return (
      <img src={imageUrl} alt={name} className={cn(base, "object-cover")} />
    );
  }

  return (
    <div
      className={cn(
        base,
        "flex items-center justify-center bg-muted font-medium text-muted-foreground",
        THUMBNAIL_INITIAL_TEXT[size],
      )}
    >
      {initial}
    </div>
  );
}

/**
 * Holds a thumbnail's box while its owner is still loading. Nothing is drawn
 * in it: a stand-in initial would show for a moment and then change into the
 * real one, which reads as the wrong account or workspace.
 */
export function ThumbnailPlaceholder({
  size = "sm",
  shape = "square",
}: {
  size?: ThumbnailSize;
  shape?: "circle" | "square";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block shrink-0",
        THUMBNAIL_SIZE[size],
        shape === "square" ? THUMBNAIL_RADIUS[size] : "rounded-full",
      )}
    />
  );
}

/**
 * A workspace: a rounded square, the shape brands are drawn for. Kept visually
 * distinct from `UserAvatar` on purpose — the shape is what tells the two
 * sidebar rows apart once they share a size.
 *
 * Clerk hands every organization an `imageUrl`, a generated placeholder
 * included, so only `hasImage` says whether an admin uploaded a logo.
 */
export function WorkspaceLogo({
  id,
  name,
  imageUrl,
  hasImage,
  size = "sm",
}: {
  id: string;
  name: string;
  imageUrl: string;
  hasImage: boolean;
  size?: ThumbnailSize;
}) {
  if (!hasImage) {
    return <DefaultWorkspaceLogo id={id} name={name} size={size} />;
  }

  return (
    <img
      src={imageUrl}
      alt={name}
      className={cn(
        THUMBNAIL_BASE,
        THUMBNAIL_SIZE[size],
        THUMBNAIL_RADIUS[size],
        "object-cover",
      )}
    />
  );
}

/**
 * The mark a workspace wears until it has a logo: a tonal brand texture with
 * the logomark on top, in a colourway chosen by the workspace id. It carries
 * no hairline — the opaque texture already gives the square its edge, the way
 * it does behind the chat home's agent avatar.
 */
export function DefaultWorkspaceLogo({
  id,
  name,
  size = "sm",
}: {
  id: string;
  name: string;
  size?: ThumbnailSize;
}) {
  const colorway = workspaceLogoColorway(id);

  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "grid shrink-0 place-items-center bg-[length:160%] bg-center",
        THUMBNAIL_SIZE[size],
        THUMBNAIL_RADIUS[size],
      )}
      style={{
        backgroundColor: colorway.ground,
        backgroundImage: `url(${colorway.textureUrl})`,
        color: colorway.mark,
      }}
    >
      {/* The mark keeps one proportion wherever the logo sits. `Button` and
          `DropdownMenuItem` size every descendant svg to an icon with
          `[&_svg]:size-4`, which outranks a plain width and would draw the
          mark at 44% of the rail button and 67% of a menu row. */}
      <OkouLogomark className="h-auto! w-[58%]!" />
    </span>
  );
}

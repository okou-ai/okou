import type { Popover } from "@base-ui/react/popover";

/**
 * The collision boundary an anchored surface keeps clear.
 *
 * Every positioned primitive shares Base UI's positioner, so they share this
 * shape; the popover's is the one it is read from.
 */
type CollisionPadding = NonNullable<
  Popover.Positioner.Props["collisionPadding"]
>;

type CollisionInset = {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
};

/** The gap an anchored surface keeps from the collision boundary. */
const COLLISION_GAP = 12;

function toInset(padding: CollisionPadding): CollisionInset {
  if (typeof padding === "number") {
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  return {
    top: padding.top ?? 0,
    right: padding.right ?? 0,
    bottom: padding.bottom ?? 0,
    left: padding.left ?? 0,
  };
}

function readInset(styles: CSSStyleDeclaration, property: string): number {
  // A custom property's computed value has already had `env()` substituted, so
  // this is a resolved length rather than the declaration's token stream.
  const parsed = Number.parseFloat(styles.getPropertyValue(property));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The safe-area boundary an anchored surface has to stay inside.
 *
 * Base UI's positioner is a JavaScript engine measuring against the raw
 * viewport, so this is the one safe-area decision CSS cannot reach. It belongs
 * here rather than at the call sites: a menu's boundary is a property of the
 * device, not of the menu.
 */
function safeAreaCollisionPadding(): CollisionInset {
  if (typeof document === "undefined") {
    return {
      top: COLLISION_GAP,
      right: COLLISION_GAP,
      bottom: COLLISION_GAP,
      left: COLLISION_GAP,
    };
  }
  const styles = window.getComputedStyle(document.documentElement);
  return {
    top: COLLISION_GAP + readInset(styles, "--sat"),
    right: COLLISION_GAP + readInset(styles, "--sar"),
    // The keyboard-aware inset, for the reason the utilities read it: a menu
    // resting on an open keyboard owes nothing to the home indicator behind it.
    bottom: COLLISION_GAP + readInset(styles, "--okou-safe-b"),
    left: COLLISION_GAP + readInset(styles, "--sal"),
  };
}

/**
 * Widens the safe-area boundary to whatever a caller asked for.
 *
 * A caller passing a number is asking for more room, not for less protection,
 * so the two combine per side instead of replacing each other. Overriding would
 * silently drop the insets on the few surfaces that state a gap of their own.
 */
export function resolveCollisionPadding(
  requested: CollisionPadding | undefined,
): CollisionInset {
  const safe = safeAreaCollisionPadding();
  if (requested === undefined) {
    return safe;
  }
  const inset = toInset(requested);
  return {
    top: Math.max(safe.top, inset.top),
    right: Math.max(safe.right, inset.right),
    bottom: Math.max(safe.bottom, inset.bottom),
    left: Math.max(safe.left, inset.left),
  };
}

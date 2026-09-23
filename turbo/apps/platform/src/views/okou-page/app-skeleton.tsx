// Match the inline first-paint wordmark in index.html.
const skeletonGlyphs = [
  {
    id: "o-orange",
    className: "w-[56px] motion-safe:[animation-delay:0ms]",
    imageClassName: "[background-image:var(--app-skeleton-o-orange)]",
  },
  {
    id: "k-blue",
    className: "w-[51px] motion-safe:[animation-delay:170ms]",
    imageClassName: "[background-image:var(--app-skeleton-k-blue)]",
  },
  {
    id: "o-green",
    className: "w-[49px] motion-safe:[animation-delay:340ms]",
    imageClassName: "[background-image:var(--app-skeleton-o-green)]",
  },
  {
    id: "u-pink",
    className: "w-[56px] motion-safe:[animation-delay:510ms]",
    imageClassName: "[background-image:var(--app-skeleton-u-pink)]",
  },
] as const;

function SkeletonWordmark() {
  return (
    <div
      aria-hidden="true"
      className="flex h-[74px] items-center justify-center gap-3"
    >
      {skeletonGlyphs.map((glyph) => {
        return (
          <span
            key={glyph.id}
            className={`flex h-[66px] shrink-0 origin-[50%_55%] items-center justify-center motion-safe:animate-app-skeleton-bounce motion-safe:will-change-transform ${glyph.className}`}
          >
            <span
              className={`block h-[54px] w-full bg-contain bg-center bg-no-repeat ${glyph.imageClassName}`}
            />
          </span>
        );
      })}
    </div>
  );
}

export function AppSkeleton({
  onHidden,
  visible = true,
}: {
  onHidden?: () => void;
  visible?: boolean;
}) {
  return (
    <div
      data-testid="app-skeleton"
      aria-hidden={visible ? undefined : true}
      aria-label="Loading"
      aria-live="polite"
      role="status"
      onTransitionEnd={(event) => {
        if (!visible && event.target === event.currentTarget) {
          onHidden?.();
        }
      }}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-background ${
        visible
          ? "opacity-100"
          : "opacity-0 pointer-events-none transition-opacity duration-300"
      }`}
    >
      <SkeletonWordmark />
    </div>
  );
}

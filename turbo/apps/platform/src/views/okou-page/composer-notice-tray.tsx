import type { ReactNode } from "react";

/**
 * The strip that carries a composer-scoped notice: the temporary model card
 * and the blocked paid tool both speak from here, in the same voice.
 */
export function ComposerNoticeTray({
  role,
  label,
  children,
}: {
  readonly role: "group" | "status";
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="relative z-0">
      {/* The surface extends one content-height behind the composer. The
          composer stays above it (z-10), while the controls remain fully
          visible in the half that protrudes below. It spans the composer's
          width and repeats the card's own rounded-3xl, so the only corners it
          ever shows — the bottom two — continue the card's outline instead of
          turning inside it. */}
      <div
        className="pointer-events-none absolute inset-x-0 -top-full bottom-0 rounded-3xl bg-gray-50"
        aria-hidden="true"
      />
      {/* Both ends sit 20px in, matching the text column of the card above:
          the ghost action already carries 12px of its own padding. */}
      <div
        className="relative flex flex-wrap items-center gap-2 py-1 pl-5 pr-2 text-xs composer-wide:flex-nowrap"
        role={role}
        aria-label={label}
        aria-live="polite"
        aria-atomic="true"
      >
        {children}
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner> & {
  readonly onReady?: () => void;
};

// Sonner takes its offsets as values rather than classes, so this is the one
// safe-area consumer that cannot reach the shared utilities. It still reads the
// keyboard-aware bottom, so a toast does not float above an open keyboard.
const SAFE_TOP = "var(--sat, env(safe-area-inset-top, 0px))";
const SAFE_BOTTOM = "var(--okou-safe-b, env(safe-area-inset-bottom, 0px))";

const DEFAULT_TOASTER_OFFSET = {
  top: `calc(${SAFE_TOP} + 24px)`,
  bottom: `calc(${SAFE_BOTTOM} + 24px)`,
} satisfies ToasterProps["offset"];

const DEFAULT_TOASTER_MOBILE_OFFSET = {
  top: `calc(${SAFE_TOP} + 12px)`,
  right: "0px",
  bottom: `calc(${SAFE_BOTTOM} + 16px)`,
  left: "0px",
} satisfies ToasterProps["mobileOffset"];

const DEFAULT_WARNING_ICON = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    height="20"
    width="20"
    className="text-[#f59e0b]"
  >
    <path
      fillRule="evenodd"
      d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z"
      clipRule="evenodd"
    />
  </svg>
);

function ToasterReady({ onReady }: { readonly onReady: () => void }) {
  const initialOnReadyRef = useRef(onReady);

  useEffect(() => {
    initialOnReadyRef.current();
  }, []);

  return null;
}

function Toaster({ onReady, ...props }: ToasterProps) {
  const {
    icons,
    mobileOffset = DEFAULT_TOASTER_MOBILE_OFFSET,
    offset = DEFAULT_TOASTER_OFFSET,
    style,
    ...rest
  } = props;
  const toaster = (
    <>
      <Sonner
        // Let clicks pass through the list's empty space. Keep the toast rule
        // non-important so Sonner can still disable hidden toast interactions.
        className="group pointer-events-none !flex !flex-col !items-center [&>[data-sonner-toast]]:pointer-events-auto"
        duration={3000}
        icons={{ warning: DEFAULT_WARNING_ICON, ...icons }}
        mobileOffset={mobileOffset}
        offset={offset}
        style={
          {
            // Sonner's unlayered colors consume these supported variables. The
            // shared tokens contain HSL channels, not complete CSS colors.
            "--normal-bg": "hsl(var(--popover))",
            "--normal-text": "hsl(var(--popover-foreground))",
            "--normal-border": "hsl(var(--border))",
            ...style,
            zIndex: 2147483647,
          } as React.CSSProperties
        }
        toastOptions={{
          classNames: {
            toast:
              "group/toast font-family-sans group-data-[sonner-toaster]:!rounded-[10px] group-data-[sonner-toaster]:!text-sm group-data-[sonner-toaster]:!font-medium group-data-[sonner-toaster]:!w-auto group-data-[sonner-toaster]:!max-w-[calc(100dvw-2rem)] sm:group-data-[sonner-toaster]:!max-w-none group-data-[sonner-toaster]:!whitespace-normal sm:group-data-[sonner-toaster]:!whitespace-nowrap group-data-[sonner-toaster]:!left-auto group-data-[sonner-toaster]:!top-auto group-data-[sonner-toaster]:!relative [&_[data-icon]]:text-green-600 [&[data-type=error]_[data-icon]]:text-red-500",
            // Sonner has no description-color variable or style slot. Preserve
            // its inherited foreground for rich-color and inverted surfaces.
            description:
              "!text-muted-foreground group-data-[rich-colors=true]/toast:!text-inherit group-data-[invert=true]/toast:!text-inherit",
          },
          actionButtonStyle: {
            background: "hsl(var(--primary))",
            color: "hsl(var(--primary-foreground))",
          },
          cancelButtonStyle: {
            background: "hsl(var(--muted))",
            color: "hsl(var(--muted-foreground))",
          },
        }}
        {...rest}
      />
      {onReady ? <ToasterReady onReady={onReady} /> : null}
    </>
  );

  if (typeof document === "undefined") {
    return toaster;
  }

  return createPortal(toaster, document.body);
}

export { Toaster, toast };

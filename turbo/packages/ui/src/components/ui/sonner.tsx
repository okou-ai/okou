import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner> & {
  readonly onReady?: () => void;
};

const DEFAULT_TOASTER_OFFSET = {
  top: "calc(var(--sat, 0px) + 24px)",
  bottom: "calc(var(--sab, 0px) + 24px)",
} satisfies ToasterProps["offset"];

const DEFAULT_TOASTER_MOBILE_OFFSET = {
  top: "calc(var(--sat, 0px) + 12px)",
  right: "0px",
  bottom: "calc(var(--sab, 0px) + 16px)",
  left: "0px",
} satisfies ToasterProps["mobileOffset"];

const DEFAULT_WARNING_ICON = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    height="20"
    width="20"
    style={{ color: "#f59e0b" }}
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
        className="toaster group pointer-events-none !flex !flex-col !items-center [&>[data-sonner-toast]]:pointer-events-auto"
        duration={3000}
        icons={{ warning: DEFAULT_WARNING_ICON, ...icons }}
        mobileOffset={mobileOffset}
        offset={offset}
        style={{
          ...style,
          zIndex: 2147483647,
        }}
        toastOptions={{
          classNames: {
            toast:
              "group toast group-[.toaster]:bg-popover group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:!rounded-[10px] group-[.toaster]:!text-sm group-[.toaster]:!font-medium group-[.toaster]:!w-auto group-[.toaster]:!max-w-[calc(100dvw-2rem)] sm:group-[.toaster]:!max-w-none group-[.toaster]:!whitespace-normal sm:group-[.toaster]:!whitespace-nowrap group-[.toaster]:!left-auto group-[.toaster]:!top-auto group-[.toaster]:!relative [&_[data-icon]]:text-green-600 [&[data-type=error]_[data-icon]]:text-red-500",
            description: "group-[.toast]:text-muted-foreground",
            actionButton:
              "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
            cancelButton:
              "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          },
          style: {
            fontFamily: "var(--font-family-sans)",
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

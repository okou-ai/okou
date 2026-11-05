import { useEffect, useRef, useState, type ReactNode } from "react";

interface TransientAlertProps {
  /** Stable outcome identities; a fresh occurrence renews the display interval. */
  readonly occurrences: readonly object[];
  readonly children: ReactNode;
  readonly className?: string;
  /** Suppress duplicate presentation without renewing its lifetime later. */
  readonly hidden?: boolean;
}

function TransientAlert({
  occurrences,
  children,
  className,
  hidden = false,
}: TransientAlertProps) {
  const [visible, setVisible] = useState(false);
  const seen = useRef<WeakSet<object> | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const observed = (seen.current ??= new WeakSet<object>());
    const fresh = occurrences.some((occurrence) => {
      return !observed.has(occurrence);
    });
    for (const occurrence of occurrences) {
      observed.add(occurrence);
    }
    if (occurrences.length === 0) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      setVisible(false);
    } else if (fresh) {
      window.clearTimeout(timer.current);
      setVisible(true);
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        setVisible(false);
      }, 3000);
    }
  }, [occurrences]);

  useEffect(() => {
    return () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      // Effect replay is a fresh presentation owner, just like a real remount.
      seen.current = null;
    };
  }, []);

  return visible && occurrences.length > 0 && !hidden ? (
    <p role="alert" className={className}>
      {children}
    </p>
  ) : null;
}

export { TransientAlert, type TransientAlertProps };

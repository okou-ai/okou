import { type ComponentProps, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

type LazySpinnerProps = ComponentProps<typeof Loader2>;

function LazySpinner({ className, ...props }: LazySpinnerProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(true);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  if (!visible) {
    return null;
  }

  return <Loader2 className={cn("animate-spin", className)} {...props} />;
}

export { LazySpinner, type LazySpinnerProps };

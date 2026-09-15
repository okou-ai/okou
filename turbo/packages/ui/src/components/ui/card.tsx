import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const cardClassName =
  "rounded-xl border border-border bg-card text-card-foreground overflow-hidden";

/** Card surfaces. `composer` is the large surface that emphasizes its own
 * border on focus instead of promoting a second ring: the chat composer and the
 * two cards that stand in its place. The `after` layer carries only the veil,
 * so focus fades through opacity rather than repainting the card. Callers keep
 * layout, stacking and container context. The veil and shadow read App runtime
 * theme values, the way the dialog viewport height already does. */
const cardVariants = cva(cardClassName, {
  variants: {
    surface: {
      default: "",
      composer:
        "relative overflow-visible rounded-3xl border-gray-300 bg-card shadow-[var(--okou-card-shadow)] transition-[border-color] duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] focus-within:border-surface-focus motion-reduce:transition-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:opacity-0 after:shadow-[var(--okou-composer-focus-veil)] after:transition-opacity after:duration-[220ms] after:ease-[cubic-bezier(0.4,0,0.2,1)] after:content-[''] focus-within:after:opacity-100 motion-reduce:after:transition-none",
    },
  },
  defaultVariants: {
    surface: "default",
  },
});

/** Page surfaces preserve the host element's layout and native semantics. */
const surfaceVariants = cva(
  "bg-card border-(length:--border-width-surface) border-solid border-surface-border shadow-surface transition-[background-color] duration-150 ease-surface",
  {
    variants: {
      radius: {
        standard: "rounded-surface",
        compact: "rounded-surface-compact",
      },
      interactive: {
        // Keep the overlay when a touch browser exposes :hover as well.
        true: "cursor-pointer [&:hover]:bg-state-hover-overlay",
        false: "",
      },
    },
    defaultVariants: {
      radius: "standard",
      interactive: false,
    },
  },
);

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardVariants>
>(({ className, surface, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(cardVariants({ surface }), className)}
      {...props}
    />
  );
});
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn("flex flex-col space-y-2 p-6 pb-2 bg-card", className)}
      {...props}
    />
  );
});
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        "text-2xl font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    />
  );
});
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />;
});
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn("flex items-center p-6 pt-0", className)}
      {...props}
    />
  );
});
CardFooter.displayName = "CardFooter";

export {
  surfaceVariants,
  cardVariants,
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  cardClassName,
};

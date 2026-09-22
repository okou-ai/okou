"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Search } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { Dialog, DialogContent } from "./dialog";

interface CommandProps extends Omit<
  Autocomplete.Root.Props<string>,
  "inline" | "items" | "open"
> {
  readonly className?: string | undefined;
}

const Command = React.forwardRef<HTMLDivElement, CommandProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <Autocomplete.Root {...props} inline open>
        <div
          ref={ref}
          data-slot="command"
          className={cn(
            "flex h-full w-full flex-col overflow-hidden rounded-xl bg-card text-foreground",
            className,
          )}
        >
          {children}
        </div>
      </Autocomplete.Root>
    );
  },
);
Command.displayName = "Command";

interface CommandDialogProps extends Omit<
  React.ComponentPropsWithoutRef<typeof Dialog>,
  "children"
> {
  readonly children?: React.ReactNode;
  readonly closeLabel?: string | undefined;
  readonly contentClassName?: string | undefined;
  readonly maxWidth?: React.ComponentProps<typeof DialogContent>["maxWidth"];
  readonly smMaxWidth?: React.ComponentProps<
    typeof DialogContent
  >["smMaxWidth"];
  readonly showCloseButton?: boolean;
  readonly commandClassName?: string | undefined;
  readonly commandProps?:
    | React.ComponentPropsWithoutRef<typeof Command>
    | undefined;
}

function CommandDialog({
  children,
  contentClassName,
  closeLabel,
  maxWidth,
  smMaxWidth,
  showCloseButton,
  commandClassName,
  commandProps,
  ...props
}: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent
        closeLabel={closeLabel}
        maxWidth={maxWidth}
        smMaxWidth={smMaxWidth}
        showCloseButton={showCloseButton}
        contentClassName={cn("overflow-hidden p-0", contentClassName)}
      >
        <Command
          {...commandProps}
          className={cn(commandClassName, commandProps?.className)}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

interface CommandInputProps extends Autocomplete.Input.Props {
  readonly wrapperClassName?: string | undefined;
}

const CommandInput = React.forwardRef<HTMLInputElement, CommandInputProps>(
  ({ className, wrapperClassName, ...props }, ref) => {
    return (
      <div
        data-slot="command-input-wrapper"
        className={cn(
          "flex h-9 items-center gap-2 rounded-lg border border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm transition-colors focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/10",
          wrapperClassName,
        )}
      >
        <Search size={16} className="shrink-0 text-muted-foreground" />
        <Autocomplete.Input
          ref={ref}
          data-slot="command-input"
          // No radius of its own: the input is transparent inside the rounded
          // wrapper, so `rounded-md` painted nothing -- it only added a rounded
          // clip. The caret sits at x=0 of this box (no horizontal padding),
          // so that clip ate its top and bottom ends and left the caret looking
          // notched.
          className={cn(
            "flex h-full w-full rounded-none bg-transparent text-sm text-foreground placeholder:text-sm placeholder:text-muted-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);
CommandInput.displayName = "CommandInput";

const CommandList = React.forwardRef<HTMLDivElement, Autocomplete.List.Props>(
  ({ className, ...props }, ref) => {
    return (
      <Autocomplete.List
        ref={ref}
        data-slot="command-list"
        className={cn("max-h-[min(520px,65vh)] overflow-y-auto", className)}
        {...props}
      />
    );
  },
);
CommandList.displayName = "CommandList";

const CommandEmpty = React.forwardRef<HTMLDivElement, Autocomplete.Empty.Props>(
  ({ className, ...props }, ref) => {
    return (
      <Autocomplete.Empty
        ref={ref}
        data-slot="command-empty"
        className={cn(
          "py-4 text-center text-sm text-muted-foreground",
          className,
        )}
        {...props}
      />
    );
  },
);
CommandEmpty.displayName = "CommandEmpty";

interface CommandGroupProps extends Autocomplete.Group.Props {
  readonly heading?: React.ReactNode;
}

const CommandGroup = React.forwardRef<HTMLDivElement, CommandGroupProps>(
  ({ children, className, heading, ...props }, ref) => {
    return (
      <Autocomplete.Group
        ref={ref}
        data-slot="command-group"
        className={cn(
          "overflow-hidden text-foreground [&_[data-slot=command-group-heading]]:px-1 [&_[data-slot=command-group-heading]]:text-xs [&_[data-slot=command-group-heading]]:font-medium [&_[data-slot=command-group-heading]]:text-muted-foreground",
          className,
        )}
        {...props}
      >
        {heading !== undefined ? (
          <Autocomplete.GroupLabel data-slot="command-group-heading">
            {heading}
          </Autocomplete.GroupLabel>
        ) : null}
        <div data-slot="command-group-items">{children}</div>
      </Autocomplete.Group>
    );
  },
);
CommandGroup.displayName = "CommandGroup";

const CommandSeparator = React.forwardRef<
  HTMLDivElement,
  Autocomplete.Separator.Props
>(({ className, ...props }, ref) => {
  return (
    <Autocomplete.Separator
      ref={ref}
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-divider", className)}
      {...props}
    />
  );
});
CommandSeparator.displayName = "CommandSeparator";

const CommandItem = React.forwardRef<HTMLDivElement, Autocomplete.Item.Props>(
  ({ className, ...props }, ref) => {
    return (
      <Autocomplete.Item
        ref={ref}
        data-slot="command-item"
        className={cn(
          "relative flex cursor-pointer select-none items-center rounded-lg text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-state-hover data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
CommandItem.displayName = "CommandItem";

const CommandShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
};
CommandShortcut.displayName = "CommandShortcut";

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
};

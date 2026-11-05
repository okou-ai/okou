import { cn } from "@okouai/ui";

/** An illustrated placeholder for a chat header panel with nothing to list. */
export function ChatPanelEmptyState({
  image,
  title,
  description,
  className,
}: {
  readonly image: string;
  readonly title: string;
  readonly description: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", className)}>
      <img
        src={image}
        alt=""
        role="presentation"
        className="h-16 w-16 object-contain opacity-80"
      />
      <p className="mt-2 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

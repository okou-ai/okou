import { useRender } from "@base-ui/react/use-render";
import { cn } from "@okouai/ui";

/**
 * Cards inside the chat transcript: notice cards, action cards, artifact and
 * media frames. One surface, one border, one shadow, one radius — before this
 * the transcript carried two radii, four border tokens and three fills.
 *
 * `filled={false}` is the same recipe without the fill, for the frames that own
 * their background (a video stage is black, not white).
 *
 * The radius and shadow read the App-owned `--okou-chat-card-*` variables,
 * which are declared on `.okou-app`. Every consumer renders inside that shell,
 * so both resolve through normal inheritance, including the gradient themes'
 * shadow override.
 *
 * The border is deliberately `border-[1px] border-gray-400` rather than the
 * shared `border` hairline and a semantic border token that `docs/styles.md`
 * would otherwise ask for. The retired rule pinned a whole pixel because
 * fractional borders visibly repaint when card contents resolve, so a card
 * flickers at its edge as an image or an iframe lands. Preserving that is the
 * point of this change; unifying the transcript's border width and colour with
 * the rest of the product is a separate, separately reviewed decision.
 *
 * The retired rule lived in `@layer components` so that a caller's composed
 * `border-*`, `bg-*` or `hover:*` utility could still win over it. A component
 * does not need that arrangement: `cn()` merges the base with the caller's
 * `className`, so a conflicting base utility is dropped rather than outranked,
 * and the browser-session card's hover and selected borders apply without any
 * layer ordering.
 */
const chatCardClassName =
  "rounded-(--okou-chat-card-radius) border-[1px] border-gray-400 shadow-(--okou-chat-card-shadow)";
const chatCardFillClassName = "bg-card";

type ChatCardProps = useRender.ComponentProps<"div"> & {
  /** Paints the shared card fill. Turn it off to own the background. */
  readonly filled?: boolean;
};

/** Renders a `div` unless `render` supplies another element. */
export function ChatCard({
  className,
  filled = true,
  render,
  ref,
  ...props
}: ChatCardProps) {
  return useRender({
    defaultTagName: "div",
    props: {
      "data-slot": "chat-card",
      ...props,
      className: cn(
        chatCardClassName,
        filled && chatCardFillClassName,
        className,
      ),
    },
    ref,
    render,
    state: {},
  });
}

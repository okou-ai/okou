import { useRender } from "@base-ui/react/use-render";
import { cn } from "@okouai/ui";

type ChatCardProps = useRender.ComponentProps<"div">;

/**
 * Cards inside the chat transcript: notice cards, action cards, artifact and
 * media frames. One surface, one border, one shadow, one radius — before this
 * the transcript carried two radii, four border tokens and three fills.
 *
 * The radius and shadow read the App-owned `--okou-chat-card-*` variables,
 * which are declared on `.okou-app`. Every consumer renders inside that shell,
 * so both resolve through normal inheritance, including the gradient themes'
 * shadow override. They are spelled `rounded-[var(…)]` / `shadow-[var(…)]` to
 * match the page-level `--okou-card-*` siblings, which are read that way at 19
 * call sites. `tailwind-merge` cannot classify an arbitrary `shadow-[var(…)]`
 * as a box-shadow, so it would not drop this base for a caller's own
 * `shadow-*`; no consumer overrides the shadow, and the paired `rounded-[…]`
 * and every colour and width utility in the base still merge normally.
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
 *
 * Renders a `div` unless `render` supplies another element.
 */
export function ChatCard({ className, render, ref, ...props }: ChatCardProps) {
  return useRender({
    defaultTagName: "div",
    props: {
      "data-slot": "chat-card",
      ...props,
      className: cn(
        "rounded-[var(--okou-chat-card-radius)] border-[1px] border-gray-400 bg-card shadow-[var(--okou-chat-card-shadow)]",
        className,
      ),
    },
    ref,
    render,
    state: {},
  });
}

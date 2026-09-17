import { cn, CopyButton } from "@okouai/ui";

/**
 * The copy control a Markdown code fence carries.
 *
 * Both fence shapes render it: the Markdown pipeline marks one on every fenced
 * block, and the Mermaid view renders one itself when a diagram's source does
 * not parse and the fence falls back to a plain code block. The treatment is
 * one decision shared by both, so it lives here rather than being spelled at
 * each call site.
 *
 * The control sits in the fence's top-right corner and only appears while the
 * pointer is over the fence. `[pre:hover_&]` spells that reveal as a plain
 * descendant selector rather than `group-hover:`, which Tailwind wraps in
 * `@media (hover: hover)`: the plain form also fires on a coarse pointer, where
 * a tap leaves a sticky hover. The hovered and pressed fills spell the ancestor
 * for the same reason, and because `pre:hover &` outranks the shared control's
 * own `hover:` fill by specificity instead of racing it inside the same
 * Tailwind layer.
 *
 * The hovered fill excludes the pressed state explicitly, because Tailwind
 * sorts the pressed variant first; the hovered fill has to step aside by
 * selector rather than by source order.
 *
 * `text-[12px]` names the size rather than taking `text-xs`, because `text-xs`
 * carries a paired line height this control does not want; its line height
 * stays whatever it resolves to at 12px.
 *
 * The transition names its three properties rather than taking `all`. This is
 * an auxiliary control revealed by hover, so the style guide asks for the
 * animating properties by name; only these three ever change, and `visibility`
 * has to stay among them because it is what holds the control on screen while
 * it fades out of reach.
 */
export function CodeBlockCopyButton({ code }: { readonly code: string }) {
  return (
    <CopyButton
      type="button"
      text={code}
      showTooltip={false}
      className={cn(
        "invisible absolute top-1.5 right-1.5 flex cursor-pointer",
        "rounded-md bg-gray-200 p-1.5 text-[12px] text-muted-foreground",
        "transition-[visibility,background-color,color] duration-300 ease-[ease]",
        "[pre:hover_&]:visible",
        "[pre:hover_&:hover:not(:active)]:bg-gray-300",
        "[pre:hover_&:hover:not(:active)]:text-foreground",
        "[pre:hover_&:active]:bg-gray-400 [pre:hover_&:active]:text-foreground",
      )}
      data-code={code}
    />
  );
}

import { getShortcutLabel } from "@okouai/ui";

export function ChatThreadMenuShortcut({
  shortcut,
}: {
  readonly shortcut: string;
}) {
  return (
    <kbd
      aria-hidden="true"
      className="ml-auto shrink-0 whitespace-nowrap pl-4 font-sans text-xs opacity-70"
    >
      {getShortcutLabel(shortcut)}
    </kbd>
  );
}

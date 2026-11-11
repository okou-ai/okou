import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronRight, CircleHelp, Keyboard } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@okouai/ui";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { publicSiteUrl } from "../../lib/public-site-url.ts";
import { setChatShortcutHelpOpen$ } from "../../signals/chat-page/chat-shortcut-help.ts";
import { ChatThreadMenuShortcut } from "./chat-thread-menu-shortcut.tsx";

/**
 * Shortcuts opens the dialog that the global shortcut opens. Only the
 * workspace shell mounts that dialog, so other surfaces list the docs alone.
 */
export function AccountHelpMenu({
  showKeyboardShortcuts,
}: {
  readonly showKeyboardShortcuts: boolean;
}) {
  const { t, i18n } = useTranslation();
  const setShortcutHelpOpen = useSet(setChatShortcutHelpOpen$);
  const { showShortcuts } = GLOBAL_KEYBOARD_SHORTCUTS;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-3 px-3">
        <CircleHelp size={18} />
        <span className="flex-1">
          {t(($) => {
            return $.settings.accountMenu.help.label;
          })}
        </span>
        <ChevronRight size={14} />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[220px]">
        {showKeyboardShortcuts && (
          <DropdownMenuItem
            onClick={() => {
              setShortcutHelpOpen(true);
            }}
            aria-keyshortcuts={showShortcuts.ariaKeyShortcuts}
            className="gap-3 px-3"
          >
            <Keyboard size={18} />
            <span>
              {t(($) => {
                return $.settings.accountMenu.help.keyboardShortcuts;
              })}
            </span>
            <ChatThreadMenuShortcut shortcut={showShortcuts.binding} />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          render={
            <a
              href={publicSiteUrl(
                i18n.resolvedLanguage ?? i18n.language,
                "docs",
              )}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
          className="gap-3 px-3"
        >
          <BookOpen size={18} />
          <span>
            {t(($) => {
              return $.settings.accountMenu.help.docs;
            })}
          </span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

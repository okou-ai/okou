import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  getShortcutParts,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

interface ShortcutEntry {
  key: string;
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: readonly ShortcutEntry[];
}

interface ShortcutHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: () => readonly ShortcutSection[];
  title?: string;
  description?: string;
}

export function ShortcutHelpDialog({
  open,
  onOpenChange,
  sections,
  title,
  description,
}: ShortcutHelpDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        maxWidth="sm"
        closeLabel={t(($) => {
          return $.appShell.shortcutHelp.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {title ??
              t(($) => {
                return $.appShell.shortcutHelp.title;
              })}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <ShortcutSectionsView sections={sections} />
      </DialogContent>
    </Dialog>
  );
}

function ShortcutSectionsView({
  sections,
}: Pick<ShortcutHelpDialogProps, "sections">) {
  return (
    <div className="space-y-4">
      {sections().map((section) => {
        return (
          <ShortcutSectionView
            key={section.title}
            title={section.title}
            shortcuts={section.shortcuts}
          />
        );
      })}
    </div>
  );
}

function ShortcutSectionView({ title, shortcuts }: ShortcutSection) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground tracking-wide mb-2">
        {title}
      </h3>
      <div className="space-y-1">
        {shortcuts.map((shortcut) => {
          return (
            <div
              key={shortcut.key}
              className="flex items-center justify-between py-1"
            >
              <span className="text-sm">{shortcut.label}</span>
              <div className="ml-4 shrink-0 flex items-center gap-1">
                {getShortcutParts(shortcut.key).map((part) => {
                  return (
                    <kbd
                      key={part}
                      className='inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md bg-background px-1.5 text-[11px] font-medium text-foreground shadow-[inset_0_-1px_0_hsl(var(--border)),0_0_0_1px_hsl(var(--border))] font-["-apple-system",BlinkMacSystemFont,"Segoe_UI",system-ui,sans-serif]'
                    >
                      {part}
                    </kbd>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

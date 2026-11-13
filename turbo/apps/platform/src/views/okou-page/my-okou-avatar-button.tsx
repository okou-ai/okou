import { IconButton, OkouAvatar, cn } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function MyOkouAvatarButton({
  size,
  className,
}: {
  size: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const openSettings = useSet(openSettingsDialogAt$);
  const pageSignal = useGet(pageSignal$);

  return (
    <IconButton
      type="button"
      className="group/avatar size-fit shrink-0 rounded-xl"
      aria-label={t(($) => {
        return $.myOkou.title;
      })}
      aria-haspopup="dialog"
      showTooltip
      onClick={() => {
        detach(openSettings("my-okou", pageSignal), Reason.DomCallback);
      }}
    >
      <OkouAvatar
        size={size}
        className={cn(
          "transition-opacity group-hover/avatar:opacity-80",
          className,
        )}
      />
    </IconButton>
  );
}

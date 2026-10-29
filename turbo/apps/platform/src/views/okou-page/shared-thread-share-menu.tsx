import type { SharedThreadAudience } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { Button, Popover, PopoverTrigger } from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentOrgInfo$ } from "../../signals/auth.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { SharedThreadVisibilitySignals } from "../../signals/shared-thread-visibility.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ShareMenuContent } from "./artifact-share-menu.tsx";

export function SharedThreadAudiencePicker({
  audience,
  disabled,
  onChange,
}: {
  readonly audience: SharedThreadAudience;
  readonly disabled: boolean;
  readonly onChange: (audience: SharedThreadAudience) => void;
}) {
  const { t } = useTranslation();
  const organization = useLastResolved(currentOrgInfo$);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={t(($) => {
              return $.artifacts.sharing.accessLabel;
            })}
          />
        }
      >
        {audience === "private"
          ? t(($) => {
              return $.artifacts.sharing.onlyMeOption;
            })
          : audience === "public"
            ? t(($) => {
                return $.artifacts.sharing.publicOption;
              })
            : t(($) => {
                return $.artifacts.sharing.organizationOptionUnnamed;
              })}
      </PopoverTrigger>
      <ShareMenuContent
        label={t(($) => {
          return $.artifacts.sharing.accessLabel;
        })}
        selected={audience}
        organizationName={organization?.name ?? null}
        unavailable={disabled}
        onChange={onChange}
      />
    </Popover>
  );
}

export function SharedThreadShareMenu({
  session,
  defaultOpen = false,
  showLabel = false,
}: {
  readonly session: SharedThreadVisibilitySignals;
  readonly defaultOpen?: boolean;
  readonly showLabel?: boolean;
}) {
  const { t } = useTranslation();
  const status = useLoadable(session.status$);
  const details = useLastResolved(session.status$);
  const [changeState, change] = useLoadableSet(session.change$);
  const copy = useSet(session.copy$);
  const copied = useGet(session.copied$);
  const signal = useGet(pageSignal$);
  const saving = changeState.state === "loading";
  const saveError = useGet(session.saveError$);
  const recipient = status.state === "hasData" && !status.data;
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={showLabel ? "default" : "quiet"}
            size={showLabel ? "default" : "icon-sm"}
            aria-label={t(($) => {
              return $.sharedThread.share;
            })}
          />
        }
      >
        <Share2 size={showLabel ? 16 : 18} />
        {showLabel
          ? t(($) => {
              return $.sharedThread.share;
            })
          : null}
      </PopoverTrigger>
      <ShareMenuContent
        label={t(($) => {
          return $.sharedThread.share;
        })}
        selected={details?.audience}
        organizationName={details?.organization.name ?? null}
        loading={!details && status.state === "loading"}
        saving={saving}
        failed={status.state === "hasError"}
        showPermissions={!recipient}
        errorMessage={
          saveError ??
          (changeState.state === "hasError"
            ? t(($) => {
                return $.artifacts.sharing.updateFailed;
              })
            : null)
        }
        onChange={(audience) => {
          detach(change(audience, signal), Reason.DomCallback);
        }}
        copy={{
          copied,
          disabled: !details && !recipient,
          onCopy: () => {
            detach(copy(signal), Reason.DomCallback);
          },
        }}
      />
    </Popover>
  );
}

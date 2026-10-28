import type { SharedThreadAudience } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentOrgInfo$ } from "../../signals/auth.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { SharedThreadVisibilitySignals } from "../../signals/shared-thread-visibility.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ShareCopyButton,
  ShareLoadError,
  SharePermissionChoices,
  ShareSkeleton,
} from "./artifact-share-menu.tsx";

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
      <PopoverContent align="end" className="w-72 p-2">
        <SharePermissionChoices
          selected={audience}
          organizationName={organization?.name ?? null}
          saving={false}
          unavailable={disabled}
          onChange={onChange}
        />
      </PopoverContent>
    </Popover>
  );
}

export function SharedThreadShareMenu({
  session,
  defaultOpen = false,
}: {
  readonly session: SharedThreadVisibilitySignals;
  readonly defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const status = useLoadable(session.status$);
  const [changeState, change] = useLoadableSet(session.change$);
  const copy = useSet(session.copy$);
  const copied = useGet(session.copied$);
  const signal = useGet(pageSignal$);
  const saving = changeState.state === "loading";
  const saveError = useGet(session.saveError$);
  const details = status.state === "hasData" ? status.data : null;
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={t(($) => {
              return $.sharedThread.share;
            })}
          />
        }
      >
        <Share2 size={18} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        {status.state === "loading" ? (
          <ShareSkeleton showCopyButton={false} />
        ) : details ? (
          <SharePermissionChoices
            selected={details.audience}
            organizationName={details.organization.name}
            saving={saving}
            unavailable={saving}
            onChange={(audience) => {
              detach(change(audience, signal), Reason.DomCallback);
            }}
          />
        ) : status.state === "hasError" ? (
          <ShareLoadError />
        ) : null}
        {saveError ? (
          <ShareLoadError message={saveError} />
        ) : changeState.state === "hasError" ? (
          <ShareLoadError
            message={t(($) => {
              return $.artifacts.sharing.updateFailed;
            })}
          />
        ) : null}
        <div className="mt-1.5 flex justify-end">
          <ShareCopyButton
            copied={copied}
            disabled={saving}
            onCopy={() => {
              detach(copy(signal), Reason.DomCallback);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

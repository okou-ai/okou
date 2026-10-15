import { useGet, useLoadable, useSet } from "ccstate-react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  refreshTeamsOrg$,
  teamsOrgData$,
} from "../../signals/okou-page/teams.ts";
import { detach, Reason } from "../../signals/utils.ts";

/** Recovery remains available when a suspended tab missed the provider event. */
export function TeamsStatusRefresh() {
  const { t } = useTranslation();
  const status = useLoadable(teamsOrgData$);
  const refresh = useSet(refreshTeamsOrg$);
  const signal = useGet(pageSignal$);
  return (
    <div className="flex flex-col gap-2">
      {status.state === "hasError" && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.connectors.providerConnect.teams.statusFailed;
          })}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={status.state === "loading"}
        onClick={() => {
          detach(refresh(signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.connectors.providerConnect.teams.refresh;
        })}
      </Button>
    </div>
  );
}

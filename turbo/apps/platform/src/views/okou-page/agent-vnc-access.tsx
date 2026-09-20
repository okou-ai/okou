import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Monitor } from "lucide-react";
import { updateAgentVncAccess$ } from "../../signals/vnc-access.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ConnectorPermissionRow } from "./components/settings/connector-permission-row.tsx";

export function AgentVncAccess({
  agentId,
  enabled,
  isLast,
}: {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly isLast: boolean;
}) {
  const { t } = useTranslation();
  const [saving, update] = useLoadableSet(updateAgentVncAccess$);
  const signal = useGet(pageSignal$);
  return (
    <ConnectorPermissionRow
      icon={<Monitor size={20} className="shrink-0" aria-hidden="true" />}
      label={t(($) => {
        return $.vnc.label;
      })}
      description={t(($) => {
        return $.vnc.accessHelp;
      })}
      enabled={enabled}
      loading={saving.state === "loading"}
      showManage={false}
      isLast={isLast}
      onToggle={(checked) => {
        return detach(update(agentId, checked, signal), Reason.DomCallback);
      }}
    />
  );
}

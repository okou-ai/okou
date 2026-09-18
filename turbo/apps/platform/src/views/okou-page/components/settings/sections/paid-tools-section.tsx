import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ChartNoAxesCombined,
  FileText,
  Globe,
  Image,
  MapPin,
  Search,
  Users,
  MessageCircle,
} from "lucide-react";
import { Button } from "@okouai/ui";
import { Switch } from "@okouai/ui/components/ui/switch";
import {
  paidToolsSettings$,
  type PaidToolsSettings,
  type PaidToolSettings,
} from "../../../../../signals/okou-page/settings/paid-tools.ts";
import { currentOrgInfo$ } from "../../../../../signals/auth.ts";
import { settingsActionSignal$ } from "../../../../../signals/okou-page/settings/settings-dialog.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { PreferenceCardRow } from "../preference-card-row.tsx";

const TOOL_ICONS = {
  "web-search": Search,
  "people-search": Users,
  scrape: FileText,
  finance: ChartNoAxesCombined,
  maps: MapPin,
  seo: Globe,
  social: MessageCircle,
  "image-recognition": Image,
} as const;

function PaidToolRow({ tool }: { readonly tool: PaidToolSettings }) {
  const { t } = useTranslation();
  const enabled = useLoadable(tool.enabled$);
  const [save, update] = useLoadableSet(tool.update$);
  const signal = useGet(settingsActionSignal$);
  const title = t(($) => {
    return $.settings.paidTools.tools[tool.toolId].name;
  });
  const pending = save.state === "loading";
  const current = enabled.state === "hasData" ? enabled.data : false;
  const toggle = (checked: boolean) => {
    if (signal) {
      detach(update(checked, signal), Reason.DomCallback);
    }
  };
  return (
    <PreferenceCardRow
      icon={TOOL_ICONS[tool.toolId]}
      title={title}
      description={t(($) => {
        return $.settings.paidTools.tools[tool.toolId].description;
      })}
      status={
        pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.paidTools.saving;
            })}
          </p>
        ) : save.state === "hasError" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.settings.paidTools.saveError;
              })}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                return toggle(!current);
              }}
            >
              {t(($) => {
                return $.settings.paidTools.retry;
              })}
            </Button>
          </div>
        ) : null
      }
    >
      <Switch
        aria-label={title}
        checked={current}
        disabled={
          enabled.state !== "hasData" || pending || !signal || signal.aborted
        }
        onCheckedChange={toggle}
      />
    </PreferenceCardRow>
  );
}

function PaidToolsContent({
  settings,
}: {
  readonly settings: PaidToolsSettings;
}) {
  const { t } = useTranslation();
  const loadable = useLoadable(settings.disabledTools$);
  const workspace = useLoadable(currentOrgInfo$);
  const retry = useSet(settings.retry$);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        {workspace.state === "hasData" && workspace.data && (
          <p>
            {t(
              ($) => {
                return $.settings.paidTools.scope;
              },
              {
                workspace: workspace.data.name,
              },
            )}
          </p>
        )}
        <p>
          {t(($) => {
            return $.settings.paidTools.timing;
          })}
        </p>
      </div>
      {loadable.state === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.paidTools.loading;
          })}
        </p>
      ) : loadable.state === "hasError" ? (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.settings.paidTools.loadError;
            })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return retry();
            }}
          >
            {t(($) => {
              return $.settings.paidTools.retry;
            })}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {settings.tools.map((tool) => {
            return <PaidToolRow key={tool.toolId} tool={tool} />;
          })}
        </div>
      )}
    </div>
  );
}

export function PaidToolsSection() {
  const { t } = useTranslation();
  const settings = useLoadable(paidToolsSettings$);
  if (settings.state !== "hasData" || !settings.data) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.settings.paidTools.loading;
        })}
      </p>
    );
  }
  return <PaidToolsContent key={settings.data.key} settings={settings.data} />;
}

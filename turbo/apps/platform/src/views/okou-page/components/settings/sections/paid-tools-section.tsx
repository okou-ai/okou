import type { Select as SelectPrimitive } from "@base-ui/react/select";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Switch } from "@okouai/ui/components/ui/switch";
import { IMAGE_MODEL_PRICE_TIER } from "@okouai/api-contracts/contracts/media-model-price-tiers";
import {
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
  resolveImageModel,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  paidToolsSettings$,
  type ImageModelSettings,
  type PaidToolsSettings,
  type PaidToolSettings,
} from "../../../../../signals/okou-page/settings/paid-tools.ts";
import { currentOrgInfo$ } from "../../../../../signals/auth.ts";
import { settingsActionSignal$ } from "../../../../../signals/okou-page/settings/settings-dialog.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { PreferenceCardRow } from "../preference-card-row.tsx";
import { getMediaModelPriceTierLabel } from "../provider-ui-config.ts";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";

const TOOL_ICONS = {
  "web-search": Search,
  "people-search": Users,
  scrape: FileText,
  finance: ChartNoAxesCombined,
  maps: MapPin,
  seo: Globe,
  social: MessageCircle,
  "image-recognition": Image,
  "image-generation": Image,
} as const;

function PaidToolRow({
  tool,
  grouped = false,
}: {
  readonly tool: PaidToolSettings;
  readonly grouped?: boolean;
}) {
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
      grouped={grouped}
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

interface ImageModelOption {
  readonly value: ImageModel;
  readonly label: string;
}

function imageModelOption(model: ImageModel): ImageModelOption {
  return { value: model, label: IMAGE_MODEL_CONFIGS[model].label };
}

/** The public picker models, plus a stored model the picker no longer offers. */
function imageModelOptions(selected: ImageModel | null): ImageModelOption[] {
  const options: ImageModelOption[] = PUBLIC_IMAGE_MODELS.map(imageModelOption);
  if (
    selected &&
    !options.some((option) => {
      return option.value === selected;
    })
  ) {
    options.push(imageModelOption(selected));
  }
  return options;
}

function ImageModelRow({
  imageModel,
  toolEnabled,
}: {
  readonly imageModel: ImageModelSettings;
  readonly toolEnabled: PaidToolSettings["enabled$"];
}) {
  const { t } = useTranslation();
  const selected = useLastLoadable(imageModel.selected$);
  const enabled = useLoadable(toolEnabled);
  const draft = useGet(imageModel.draft$);
  const [save, update] = useLoadableSet(imageModel.update$);
  const signal = useGet(settingsActionSignal$);
  const label = t(($) => {
    return $.settings.paidTools.imageModel.label;
  });
  const pending = save.state === "loading";
  // The unsaved choice stays visible independently of the request lifecycle.
  // A successful save reconciles it with the stored preference.
  const current =
    draft ?? (selected.state === "hasData" ? selected.data : null);
  const options = imageModelOptions(current);
  const submit = (model: ImageModel) => {
    if (signal) {
      detach(update(model, signal), Reason.DomCallback);
    }
  };
  const handleChange = (
    value: string | null,
    details: SelectPrimitive.Root.ChangeEventDetails,
  ) => {
    const model = value === null ? undefined : resolveImageModel(value);
    if (!model || pending) {
      details.cancel();
      return;
    }
    if (model === current && details.reason === "none") {
      return;
    }
    submit(model);
  };
  return (
    <div className="flex flex-col gap-3 bg-card px-4 pb-4 sm:flex-row sm:items-center sm:gap-4 sm:pl-15">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.paidTools.imageModel.description;
          })}
        </div>
        {pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.paidTools.saving;
            })}
          </p>
        ) : save.state === "hasError" && draft ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.settings.paidTools.imageModel.saveError;
              })}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                submit(draft);
              }}
            >
              {t(($) => {
                return $.settings.paidTools.retry;
              })}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="w-full shrink-0 sm:w-56">
        <Select
          items={options}
          value={current}
          disabled={
            current === null ||
            enabled.state !== "hasData" ||
            !enabled.data ||
            pending ||
            !signal ||
            signal.aborted
          }
          onValueChange={handleChange}
        >
          <SelectTrigger aria-label={label} variant="neutral">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {options.map((option) => {
              const tier = IMAGE_MODEL_PRICE_TIER[option.value];
              return (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                    </span>
                    <span
                      className="shrink-0 text-xs font-medium text-muted-foreground"
                      title={getMediaModelPriceTierLabel(tier)}
                    >
                      {tier}
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ImageGenerationRows({
  tool,
  imageModel,
}: {
  readonly tool: PaidToolSettings;
  readonly imageModel: ImageModelSettings;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-surface-border">
      <PaidToolRow tool={tool} grouped />
      <ImageModelRow imageModel={imageModel} toolEnabled={tool.enabled$} />
    </div>
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
        <>
          <div className="flex flex-col gap-3">
            {settings.tools.map((tool) => {
              return tool.toolId === "image-generation" ? (
                <ImageGenerationRows
                  key={tool.toolId}
                  tool={tool}
                  imageModel={settings.imageModel}
                />
              ) : (
                <PaidToolRow key={tool.toolId} tool={tool} />
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {workspace.state === "hasData" && workspace.data && (
              <>
                <span>
                  {t(
                    ($) => {
                      return $.settings.paidTools.scope;
                    },
                    {
                      workspace: workspace.data.name,
                    },
                  )}
                </span>{" "}
              </>
            )}
            <span>
              {t(($) => {
                return $.settings.paidTools.timing;
              })}
            </span>
          </p>
        </>
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

export function ToolsSection() {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3">
      <SettingsSectionHeading
        title={t(($) => {
          return $.settings.paidTools.title;
        })}
      />
      <PaidToolsSection />
    </section>
  );
}

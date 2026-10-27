import type { Select as SelectPrimitive } from "@base-ui/react/select";
import { useGet, useLastLoadable, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Database, Image, Search, type LucideIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Switch } from "@okouai/ui/components/ui/switch";
import { IMAGE_MODEL_PRICE_TIER } from "@okouai/api-contracts/contracts/image-model-price-tiers";
import {
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
  resolveImageModel,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { dataRouterFamilyText } from "@okouai/api-contracts/contracts/data-router-tools";
import {
  paidToolsSettings$,
  type DataFamilySettings,
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
  "image-generation": Image,
} as const;

function ToolToggleRow({
  tool,
  icon,
  title,
  description,
  grouped = false,
}: {
  readonly tool: PaidToolSettings | DataFamilySettings;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  readonly grouped?: boolean;
}) {
  const { t } = useTranslation();
  const enabled = useLoadable(tool.enabled$);
  const [save, update] = useLoadableSet(tool.update$);
  const signal = useGet(settingsActionSignal$);
  const pending = save.state === "loading";
  const current = enabled.state === "hasData" ? enabled.data : false;
  const toggle = (checked: boolean) => {
    if (signal) {
      detach(update(checked, signal), Reason.DomCallback);
    }
  };
  return (
    <PreferenceCardRow
      icon={icon}
      grouped={grouped}
      title={title}
      description={description}
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

function PaidToolRow({
  tool,
  grouped = false,
}: {
  readonly tool: PaidToolSettings;
  readonly grouped?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ToolToggleRow
      tool={tool}
      icon={TOOL_ICONS[tool.toolId]}
      grouped={grouped}
      title={t(($) => {
        return $.settings.paidTools.tools[tool.toolId].name;
      })}
      description={t(($) => {
        return $.settings.paidTools.tools[tool.toolId].description;
      })}
    />
  );
}

/** Router owns family text; the App only selects the current locale. */
function DataFamilyRow({ tool }: { readonly tool: DataFamilySettings }) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <ToolToggleRow
      tool={tool}
      icon={Database}
      title={dataRouterFamilyText(tool.family.title, locale, tool.family.id)}
      description={dataRouterFamilyText(
        tool.family.description,
        locale,
        tool.family.id,
      )}
    />
  );
}

function DataFamilyRows({
  settings,
}: {
  readonly settings: PaidToolsSettings;
}) {
  const families = useLoadable(settings.dataFamilies$);
  if (families.state !== "hasData") {
    return <PaidToolsLoadStatus failed={families.state === "hasError"} />;
  }
  return families.data.map((tool) => {
    return <DataFamilyRow key={tool.toolId} tool={tool} />;
  });
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
                      aria-description={getMediaModelPriceTierLabel(tier)}
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

function PaidToolsLoadStatus({
  failed = false,
}: {
  readonly failed?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3">
      <p
        role={failed ? "alert" : "status"}
        className={
          failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"
        }
      >
        {t(($) => {
          return failed
            ? $.settings.paidTools.loadError
            : $.settings.paidTools.loading;
        })}
      </p>
    </div>
  );
}

function PaidToolsContent({
  settings,
}: {
  readonly settings: PaidToolsSettings;
}) {
  const { t } = useTranslation();
  const loadable = useLastLoadable(settings.disabledTools$);
  const workspace = useLoadable(currentOrgInfo$);
  return (
    <div className="flex flex-col gap-4">
      {loadable.state !== "hasData" ? (
        <PaidToolsLoadStatus failed={loadable.state === "hasError"} />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <PaidToolRow tool={settings.webSearch} />
            <DataFamilyRows settings={settings} />
            <ImageGenerationRows
              tool={settings.imageGeneration}
              imageModel={settings.imageModel}
            />
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
  const settings = useLoadable(paidToolsSettings$);
  if (settings.state !== "hasData" || !settings.data) {
    return <PaidToolsLoadStatus />;
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

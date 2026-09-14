import { useGet, useLoadable } from "ccstate-react";
import { Monitor, GitCommit, Package } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@okouai/ui";

import { getBuildCommitSha } from "../../../../lib/build-info.ts";
import { appVersion$ } from "../../../../signals/app-version.ts";
import { backendBuildInfo$ } from "../../../../signals/okou-page/settings/build-info.ts";

function formatBuildInfoValue(
  value: string | null | undefined,
  unavailable: string,
): string {
  return value ?? unavailable;
}

function BuildInfoTarget({
  title,
  version,
  commitSha,
  icon: Icon,
}: {
  readonly title: string;
  readonly version: string;
  readonly commitSha: string;
  readonly icon: typeof GitCommit;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
            <Icon size={15} />
          </span>
          <div className="truncate text-sm font-medium text-foreground">
            {title}
          </div>
        </div>
        <Badge
          render={<code />}
          className="min-w-0 text-right text-xs font-medium text-foreground break-all"
        >
          {version}
        </Badge>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-xs text-muted-foreground">
          {t(($) => {
            return $.settings.buildInfo.commitSha;
          })}
        </div>
        <code className="block min-h-7 break-all rounded-md bg-muted/40 px-2 py-1.5 text-[11px] leading-4 text-foreground">
          {commitSha}
        </code>
      </div>
    </div>
  );
}

export function BuildInfoBlock() {
  const { t } = useTranslation();
  const appVersion = useGet(appVersion$);
  const backendBuildInfoLoadable = useLoadable(backendBuildInfo$);
  const loading = backendBuildInfoLoadable.state === "loading";
  const backendBuildInfo =
    backendBuildInfoLoadable.state === "hasData"
      ? backendBuildInfoLoadable.data
      : null;
  const unavailable = t(($) => {
    return $.settings.buildInfo.unavailable;
  });
  const loadingLabel = t(($) => {
    return $.settings.buildInfo.loading;
  });
  const frontendCommitSha = formatBuildInfoValue(
    getBuildCommitSha(),
    unavailable,
  );
  const frontendVersion = formatBuildInfoValue(appVersion, unavailable);
  const backendCommitSha = loading
    ? loadingLabel
    : formatBuildInfoValue(backendBuildInfo?.backendCommitSha, unavailable);
  const backendVersion = loading
    ? loadingLabel
    : formatBuildInfoValue(backendBuildInfo?.backendVersion, unavailable);

  return (
    <div className="flex items-start gap-4 rounded-xl bg-card p-4 border border-surface-border">
      <div className="shrink-0">
        <div className="flex h-7 w-7 items-center justify-center">
          <GitCommit size={22} className="text-muted-foreground" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.settings.buildInfo.title;
          })}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 sm:gap-0">
          <div className="min-w-0 sm:pr-5">
            <BuildInfoTarget
              title={t(($) => {
                return $.settings.buildInfo.frontend;
              })}
              version={frontendVersion}
              commitSha={frontendCommitSha}
              icon={Monitor}
            />
          </div>
          <div className="min-w-0 border-t border-border/60 pt-4 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
            <BuildInfoTarget
              title={t(($) => {
                return $.settings.buildInfo.backend;
              })}
              version={backendVersion}
              commitSha={backendCommitSha}
              icon={Package}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

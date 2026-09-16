import { ArrowUpRight, TriangleAlert, Wrench, X } from "lucide-react";
import { useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from "@okouai/ui";
import { Button } from "@okouai/ui/components/ui/button";
import { Card, CardContent } from "@okouai/ui/components/ui/card";

import {
  dismissInstatusIssue$,
  type InstatusIssue,
  visibleInstatusIssues$,
} from "../../signals/instatus-status.ts";
import { resolvePlatformServiceStatusConfig } from "../../lib/platform-host.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../okou-page/sidebar-breakpoint.ts";

function InstatusIssueNotice({
  issue,
  onDismiss,
  compact,
  pageBaseUrl,
}: {
  readonly issue: InstatusIssue;
  readonly onDismiss: (issueId: string) => void;
  readonly compact: boolean;
  readonly pageBaseUrl: string;
}) {
  const { t } = useTranslation();
  let statusLabel: string;
  switch (issue.status.toUpperCase()) {
    case "INVESTIGATING": {
      statusLabel = t(($) => {
        return $.serviceStatus.statuses.investigating;
      });
      break;
    }
    case "IDENTIFIED": {
      statusLabel = t(($) => {
        return $.serviceStatus.statuses.identified;
      });
      break;
    }
    case "MONITORING": {
      statusLabel = t(($) => {
        return $.serviceStatus.statuses.monitoring;
      });
      break;
    }
    case "NOTSTARTEDYET": {
      statusLabel = t(($) => {
        return $.serviceStatus.statuses.maintenanceScheduled;
      });
      break;
    }
    case "INPROGRESS": {
      statusLabel = t(($) => {
        return $.serviceStatus.statuses.maintenanceInProgress;
      });
      break;
    }
    default: {
      statusLabel =
        issue.type === "incident"
          ? t(($) => {
              return $.serviceStatus.statuses.incident;
            })
          : t(($) => {
              return $.serviceStatus.statuses.maintenance;
            });
    }
  }
  const StatusIcon = issue.type === "incident" ? TriangleAlert : Wrench;

  return (
    <Card
      role="status"
      aria-label={`${statusLabel}: ${issue.title}`}
      surface="composer"
    >
      <CardContent className={compact ? "p-3" : "p-4"}>
        <div className="flex items-start gap-3">
          <span
            className={`${compact ? "size-8" : "size-9"} flex shrink-0 items-center justify-center rounded-lg bg-gray-50 text-brand-text`}
          >
            <StatusIcon aria-hidden="true" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
              {statusLabel}
            </div>
            <p className="mt-1.5 text-sm font-medium leading-5 text-foreground">
              {issue.title}
            </p>
            <a
              href={`${pageBaseUrl}/${encodeURIComponent(issue.id)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-text transition-colors hover:text-brand-text-hover"
            >
              {t(($) => {
                return $.serviceStatus.viewUpdates;
              })}
              <ArrowUpRight aria-hidden="true" size={14} />
            </a>
          </div>
          <Button
            type="button"
            variant="quiet"
            size="icon-xs"
            showTooltip
            aria-label={t(($) => {
              return $.serviceStatus.dismiss;
            })}
            className="-mr-1 -mt-1 shrink-0"
            onClick={() => {
              onDismiss(issue.id);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function InstatusStatusNotice({
  placement = "floating",
}: {
  readonly placement?: "floating" | "sidebar";
}) {
  const { t } = useTranslation();
  const issues = useLastResolved(visibleInstatusIssues$) ?? [];
  const dismissIssue = useSet(dismissInstatusIssue$);
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  const config = resolvePlatformServiceStatusConfig(window.location.hostname);
  const placementMatchesViewport =
    placement === "floating" ? isDesktop : !isDesktop;

  if (!config || !placementMatchesViewport || issues.length === 0) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label={t(($) => {
        return $.serviceStatus.label;
      })}
      className={
        placement === "sidebar"
          ? "mx-2 mt-2 flex max-h-[min(40dvh,320px)] shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain"
          : "pointer-events-none fixed inset-x-3 bottom-[calc(var(--sab,0px)+16px)] z-[2147483646] flex max-h-[calc(100dvh-32px)] flex-col gap-3 overflow-y-auto sm:left-6 sm:right-auto sm:w-[390px]"
      }
    >
      {issues.map((issue) => {
        return (
          <div key={issue.id} className="pointer-events-auto">
            <InstatusIssueNotice
              issue={issue}
              onDismiss={dismissIssue}
              compact={placement === "sidebar"}
              pageBaseUrl={config.pageBaseUrl}
            />
          </div>
        );
      })}
    </div>
  );
}

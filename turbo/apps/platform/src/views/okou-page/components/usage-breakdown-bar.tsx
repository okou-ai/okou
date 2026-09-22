import { Button, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type {
  UsageRecordKind,
  UsageRecordKindBreakdown,
} from "@okouai/api-contracts/contracts/usage-record";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";

import { i18n } from "../../../i18n/index.ts";
import { formatLocalizedNumber } from "../../../i18n/format.ts";
import { buildCreditUsageDisplaySegments } from "../../../lib/credit-usage-display.ts";

export const USAGE_KIND_META = {
  model: {
    color: "bg-usage-kind-model",
  },
  image: {
    color: "bg-usage-kind-image",
  },
  video: {
    color: "bg-usage-kind-video",
  },
  connector: {
    color: "bg-usage-kind-connector",
  },
  other: {
    color: "bg-usage-kind-other",
  },
} as const satisfies Record<UsageRecordKind, { color: string }>;

export function usageKindLabel(kind: UsageRecordKind): string {
  switch (kind) {
    case "model": {
      return i18n.t(($) => {
        return $.usage.kinds.model;
      });
    }
    case "image": {
      return i18n.t(($) => {
        return $.usage.kinds.image;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.usage.kinds.video;
      });
    }
    case "connector": {
      return i18n.t(($) => {
        return $.usage.kinds.connector;
      });
    }
    case "other": {
      return i18n.t(($) => {
        return $.usage.kinds.other;
      });
    }
  }
}

function UsageSegmentDetails({
  segment,
}: {
  segment: ReturnType<typeof buildCreditUsageDisplaySegments>[number];
}) {
  return (
    <div>
      <div className="font-medium text-foreground">
        {usageKindLabel(segment.kind)} -{" "}
        {formatLocalizedNumber(segment.credits)}
      </div>
      <dl className="mt-1 flex flex-col gap-0.5">
        {segment.rows.map((row) => {
          return (
            <div
              key={row.key}
              className="flex min-w-0 justify-between gap-3 text-xs text-muted-foreground"
            >
              <dt className="min-w-0 break-words">{row.label}</dt>
              <dd className="shrink-0 tabular-nums">
                {formatLocalizedNumber(row.credits)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function UsageBreakdownBar({
  credits,
  breakdown,
  max,
  testIdPrefix = "usage-kind-segment",
}: {
  credits: number;
  breakdown: readonly UsageRecordKindBreakdown[];
  max: number;
  testIdPrefix?: string;
}) {
  const { t } = useTranslation();
  const detailsLabel = t(($) => {
    return $.usage.viewBreakdown;
  });
  const segments = buildCreditUsageDisplaySegments(breakdown);
  if (credits <= 0 || segments.length === 0) {
    return null;
  }

  // The outer track compares magnitude across sibling rows. The segments inside
  // the fill show this row's usage mix.
  return (
    <div>
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/8">
        <div
          className="flex h-full overflow-hidden rounded-full"
          style={{ width: `${(credits / max) * 100}%` }}
        >
          {segments.map((segment) => {
            const meta = USAGE_KIND_META[segment.kind];
            const width = `${(segment.credits / credits) * 100}%`;
            return (
              <Tooltip key={segment.kind}>
                <TooltipTrigger
                  render={
                    <div
                      className={`${meta.color} h-full cursor-default first:rounded-l-full last:rounded-r-full transition-shadow hover:z-10 hover:ring-2 hover:ring-foreground/30`}
                      style={{ width }}
                      data-testid={`${testIdPrefix}-${segment.kind}`}
                    />
                  }
                />
                <TooltipContent
                  side="top"
                  sideOffset={8}
                  style={{
                    backgroundColor: "hsl(var(--popover))",
                    color: "hsl(var(--popover-foreground))",
                  }}
                  className="max-w-64 border shadow-md"
                >
                  <UsageSegmentDetails segment={segment} />
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <Popover>
        <PopoverTrigger
          render={
            <Button type="button" variant="quiet" size="xs" className="mt-1">
              {detailsLabel}
            </Button>
          }
        />
        <PopoverContent
          aria-label={detailsLabel}
          align="start"
          className="flex max-h-80 w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto text-sm"
        >
          {segments.map((segment) => {
            return <UsageSegmentDetails key={segment.kind} segment={segment} />;
          })}
        </PopoverContent>
      </Popover>
    </div>
  );
}

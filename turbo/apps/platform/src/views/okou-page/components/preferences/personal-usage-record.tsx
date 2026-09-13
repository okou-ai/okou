import type { MouseEvent } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import {
  ChevronDown,
  Clock,
  Mail,
  MessageCircle,
  Phone,
  Bot,
} from "lucide-react";
import type { OrgMember } from "@okouai/api-contracts/contracts/org-members";
import type {
  UsageRecordKind,
  UsageRecordRange,
  UsageRecordResponse,
  UsageRecordRow,
  UsageRecordSource,
} from "@okouai/api-contracts/contracts/usage-record";
import type { UsageMembersResponse } from "@okouai/api-contracts/contracts/usage";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  BrandGithub,
  BrandSlack,
  BrandTelegram,
} from "@okouai/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import {
  loadMoreUsageRecord$,
  myUsageRecordAsync$,
  teamMemberUsageAsync$,
} from "../../../../signals/okou-page/settings/personal-usage-record.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { orgMembers$ } from "../../../../signals/external/org-members.ts";
import { closeSettingsModal$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { nowDate } from "../../../../lib/time.ts";
import { getCreditUsageDisplayName } from "../../../../lib/credit-usage-display.ts";
import { Link } from "../../../router/link.tsx";
import { MemberUsageTable } from "../org-manage/org-usage-tab.tsx";
import { emptyUsageImg } from "../../platform-assets.ts";
import { useTranslation } from "react-i18next";
import { currentLocale, i18n } from "../../../../i18n/index.ts";
import {
  formatCompactNumber,
  formatLocalizedNumber,
} from "../../../../i18n/format.ts";

const CARD_BORDER = "var(--border-width-surface) solid hsl(var(--gray-400))";

const SOURCE_ICONS = {
  chat: MessageCircle,
  automation: Clock,
  slack: BrandSlack,
  teams: MessageCircle,
  telegram: BrandTelegram,
  email: Mail,
  agentphone: Phone,
  github: BrandGithub,
  agent: Bot,
  other: Bot,
} as const satisfies Record<UsageRecordSource, typeof MessageCircle>;

const KIND_META = {
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

const RANGE_OPTIONS = [
  "today",
  "yesterday",
  "24h",
  "7d",
  "billingPeriod",
] as const satisfies readonly UsageRecordRange[];

// Row divider is an inset hairline (pseudo-element with horizontal margin) so
// it doesn't run edge-to-edge into the card border. The row itself is no longer
// clickable — only the title text is — so there's no row-wide hover fill.
const ROW_CLASS =
  "relative px-5 py-3.5 [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:inset-x-5 [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:border-t [&:not(:first-child)]:before:border-border/50 [&:not(:first-child)]:before:content-['']";

// Dotted-underline link affordance for navigable titles. leading-6 keeps the line box
// tall enough that the offset-4 underline isn't clipped by `truncate`'s
// overflow-hidden. inline-block + max-w-full keeps the hover fill hugging the
// title text (not the whole row), truncating long titles; the chip padding /
// negative margin are right-only (-mr-1.5/pr-1.5) so the hover chip's left edge
// stays flush with the title text and the breakdown bar below. The keyboard
// focus ring is inset so the list card's overflow-hidden cannot clip it.
const TITLE_LINK_CLASS =
  "inline-block max-w-full -mr-1.5 truncate rounded-md pr-1.5 py-1 text-sm leading-6 font-medium text-foreground decoration-dotted underline decoration-foreground/40 decoration-[1px] underline-offset-4 transition-colors hover:bg-state-hover hover:decoration-foreground focus-visible:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

type UsageRecordLoadable =
  | { readonly state: "loading" }
  | { readonly state: "hasError" }
  | { readonly state: "hasData"; readonly data: UsageRecordResponse };

type UsageMembersLoadable =
  | { readonly state: "loading" }
  | { readonly state: "hasError" }
  | { readonly state: "hasData"; readonly data: UsageMembersResponse };

function formatCredits(n: number): string {
  return formatCompactNumber(n);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === nowDate().getFullYear();
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

function rangeLabel(range: UsageRecordRange): string {
  switch (range) {
    case "today": {
      return i18n.t(($) => {
        return $.usage.range.today;
      });
    }
    case "yesterday": {
      return i18n.t(($) => {
        return $.usage.range.yesterday;
      });
    }
    case "24h": {
      return i18n.t(($) => {
        return $.usage.range.last24Hours;
      });
    }
    case "7d": {
      return i18n.t(($) => {
        return $.usage.range.last7Days;
      });
    }
    case "billingPeriod": {
      return i18n.t(($) => {
        return $.usage.range.billingPeriod;
      });
    }
  }
}

function sourceLabel(source: UsageRecordSource): string {
  switch (source) {
    case "chat": {
      return i18n.t(($) => {
        return $.usage.sources.chat;
      });
    }
    case "automation": {
      return i18n.t(($) => {
        return $.usage.sources.automation;
      });
    }
    case "slack": {
      return i18n.t(($) => {
        return $.usage.sources.slack;
      });
    }
    case "teams": {
      return i18n.t(($) => {
        return $.usage.sources.teams;
      });
    }
    case "telegram": {
      return i18n.t(($) => {
        return $.usage.sources.telegram;
      });
    }
    case "email": {
      return i18n.t(($) => {
        return $.usage.sources.email;
      });
    }
    case "agentphone": {
      return i18n.t(($) => {
        return $.usage.sources.phone;
      });
    }
    case "github": {
      return i18n.t(($) => {
        return $.usage.sources.github;
      });
    }
    case "agent": {
      return i18n.t(($) => {
        return $.usage.sources.agent;
      });
    }
    case "other": {
      return i18n.t(($) => {
        return $.usage.sources.other;
      });
    }
  }
}

function kindLabel(kind: UsageRecordKind): string {
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

function usageRowKey(row: UsageRecordRow): string {
  return `${row.source}:${row.threadId ?? row.runId ?? row.lastActivityAt}:${row.member?.userId ?? "mine"}`;
}

export function UsageRangeSelect({
  value,
  onChange,
}: {
  value: UsageRecordRange;
  onChange: (range: UsageRecordRange) => void;
}) {
  useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="neutral" size="sm" className="h-9 shrink-0 rounded-lg">
          {rangeLabel(value)}
          <ChevronDown size={14} className="ml-1.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {RANGE_OPTIONS.map((option) => {
          return (
            <DropdownMenuItem
              key={option}
              onClick={() => {
                onChange(option);
              }}
            >
              {rangeLabel(option)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsageBreakdownBar({ row, max }: { row: UsageRecordRow; max: number }) {
  const segments = row.breakdown.filter((segment) => {
    return segment.credits > 0;
  });
  if (row.credits <= 0 || segments.length === 0) {
    return null;
  }

  // Outer track is the full row width; the filled portion is scaled to this
  // chat's size relative to the largest chat, so the bar reads as magnitude.
  // The kind colors live inside the fill, so one bar carries both size and mix.
  return (
    <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/8">
      <div
        className="flex h-full overflow-hidden rounded-full"
        style={{ width: `${(row.credits / max) * 100}%` }}
      >
        {segments.map((segment) => {
          const meta = KIND_META[segment.kind];
          const width = `${(segment.credits / row.credits) * 100}%`;
          return (
            <Tooltip key={segment.kind}>
              <TooltipTrigger asChild>
                <div
                  className={`${meta.color} h-full cursor-default first:rounded-l-full last:rounded-r-full transition-shadow hover:z-10 hover:ring-2 hover:ring-foreground/30`}
                  style={{ width }}
                  data-testid={`usage-kind-segment-${segment.kind}`}
                />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={8}
                style={{
                  backgroundColor: "hsl(var(--popover))",
                  color: "hsl(var(--popover-foreground))",
                }}
                className="max-w-64 border shadow-md"
              >
                <div className="font-medium text-foreground">
                  {kindLabel(segment.kind)} -{" "}
                  {formatLocalizedNumber(segment.credits)}
                </div>
                <div className="mt-1 flex flex-col gap-0.5">
                  {segment.providers.flatMap((provider) => {
                    const usageKinds =
                      provider.usageKinds && provider.usageKinds.length > 0
                        ? provider.usageKinds
                        : [{ kind: segment.kind, credits: provider.credits }];
                    return usageKinds.map((usageKind) => {
                      return (
                        <div
                          key={`${provider.provider}:${usageKind.kind}`}
                          className="flex min-w-0 justify-between gap-3 text-xs text-muted-foreground"
                        >
                          <span className="truncate">
                            {getCreditUsageDisplayName(
                              usageKind.kind,
                              provider.provider,
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {formatLocalizedNumber(usageKind.credits)}
                          </span>
                        </div>
                      );
                    });
                  })}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function UsageRow({ row, max }: { row: UsageRecordRow; max: number }) {
  const { t } = useTranslation();
  const closeSettings = useSet(closeSettingsModal$);
  const Icon = SOURCE_ICONS[row.source];
  const label = sourceLabel(row.source);
  const title =
    row.title && row.title.length > 0
      ? row.title
      : t(($) => {
          return $.usage.records.untitled;
        });

  const closeOnNavigate = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      return;
    }
    closeSettings();
  };
  const credits = formatCredits(row.credits);

  // Only the title is a navigation target. Thread rows open the chat, run rows
  // open the activity; rows with neither stay plain text.
  const titleLink = row.threadId
    ? {
        pathname: "/chats/:threadId" as const,
        options: { pathParams: { threadId: row.threadId } },
      }
    : row.runId
      ? {
          pathname: "/activities/:activityRunId" as const,
          options: { pathParams: { activityRunId: row.runId } },
        }
      : null;

  const titleNode = titleLink ? (
    // Wrapper reserves the flex space so date/credits stay right-aligned, while
    // the inner link only grows to the text width — keeping the hover fill tight.
    // flex (not block) so the inline-block link doesn't add a line-box descender
    // strut, which would make this column taller than the square icon and leave
    // the bar's bottom edge unaligned with the icon.
    <span className="flex min-w-0 flex-1 items-center">
      <Link
        pathname={titleLink.pathname}
        options={titleLink.options}
        className={TITLE_LINK_CLASS}
        onClick={closeOnNavigate}
      >
        {title}
      </Link>
    </span>
  ) : (
    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
      {title}
    </span>
  );

  return (
    <div className={ROW_CLASS}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          title={label}
          aria-label={label}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground"
        >
          <Icon size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-h-8 min-w-0 items-center gap-3">
            {titleNode}
            <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {formatDate(row.lastActivityAt)}
            </span>
            <span className="shrink-0 whitespace-nowrap text-right text-sm font-medium text-foreground tabular-nums">
              {credits}
            </span>
          </span>
          {row.member ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {row.member.email}
            </span>
          ) : null}
          <UsageBreakdownBar row={row} max={max} />
        </span>
      </div>
    </div>
  );
}

function UsageRecordSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-xl bg-card"
      style={{ border: CARD_BORDER }}
    >
      {[0, 1, 2].map((i) => {
        return (
          <div
            key={i}
            className="flex animate-pulse items-center gap-3 px-5 py-3.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50"
          >
            <span className="h-8 w-8 rounded-lg bg-muted/40" />
            <span className="min-w-0 flex-1">
              <span className="block h-4 w-40 rounded bg-muted/50" />
              <span className="mt-2 block h-2 w-full rounded bg-muted/30" />
            </span>
            <span className="h-4 w-12 rounded bg-muted/40" />
          </div>
        );
      })}
    </div>
  );
}

function emptyTitle(range: UsageRecordRange): string {
  if (range === "billingPeriod") {
    return i18n.t(($) => {
      return $.usage.records.empty.billingPeriodTitle;
    });
  }
  return i18n.t(($) => {
    return $.usage.records.empty.rangeTitle;
  });
}

// The list, the skeleton, and this share the same card so switching ranges does
// not change the shape of the section.
function UsageRecordEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      className="flex flex-col items-center rounded-xl bg-card px-6 py-12 text-center"
      style={{ border: CARD_BORDER }}
      data-testid="usage-records-empty"
    >
      <img
        src={emptyUsageImg}
        alt=""
        role="presentation"
        loading="lazy"
        className="h-24 w-24 object-contain opacity-80"
      />
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

// Summary + type legend above the list. The credit total is range-wide (from
// the server), so it stays correct as more pages load in.
function UsageRecordSummary({
  count,
  totalCredits,
}: {
  count: number;
  totalCredits: number;
}) {
  const { t } = useTranslation();
  const kinds = Object.keys(KIND_META) as UsageRecordKind[];
  const chats = t(
    ($) => {
      return $.usage.units.chat;
    },
    {
      count,
      value: formatLocalizedNumber(count),
    },
  );
  const credits = t(
    ($) => {
      return $.usage.units.credit;
    },
    {
      count: totalCredits,
      value: formatCredits(totalCredits),
    },
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          {chats}
        </span>{" "}
        · {credits}
      </p>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        {kinds.map((kind) => {
          return (
            <span
              key={kind}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                className={`${KIND_META[kind].color} h-2 w-2 shrink-0 rounded-full`}
              />
              {kindLabel(kind)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function UsageRecordList({ data }: { data: UsageRecordResponse }) {
  const { t } = useTranslation();
  const loadMore = useSet(loadMoreUsageRecord$);
  const pageSignal = useGet(pageSignal$);
  const maxCredits = Math.max(
    1,
    ...data.rows.map((row) => {
      return row.credits;
    }),
  );

  return (
    <div className="flex flex-col gap-3">
      <TooltipProvider delayDuration={100}>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={{ border: CARD_BORDER }}
        >
          <UsageRecordSummary
            count={data.pagination.total}
            totalCredits={data.totalCredits}
          />
          {data.rows.map((row) => {
            return (
              <UsageRow key={usageRowKey(row)} row={row} max={maxCredits} />
            );
          })}
        </div>
      </TooltipProvider>
      {data.rows.length < data.pagination.total && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 rounded-lg text-muted-foreground hover:bg-state-hover hover:text-foreground"
            onClick={() => {
              detach(
                loadMore(pageSignal),
                Reason.DomCallback,
                "personal usage record paging",
              );
            }}
          >
            {t(($) => {
              return $.usage.records.loadMore;
            })}
          </Button>
        </div>
      )}
    </div>
  );
}

function UsageRecordContent({
  loadable,
  range,
}: {
  loadable: UsageRecordLoadable;
  range: UsageRecordRange;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-4">
      {loadable.state === "loading" && <UsageRecordSkeleton />}
      {loadable.state === "hasError" && (
        <p className="text-sm text-muted-foreground" role="alert">
          {t(($) => {
            return $.usage.records.loadError;
          })}
        </p>
      )}
      {loadable.state === "hasData" &&
        (loadable.data.rows.length === 0 ? (
          <UsageRecordEmpty
            title={emptyTitle(range)}
            description={t(($) => {
              return $.usage.records.empty.description;
            })}
          />
        ) : (
          <UsageRecordList data={loadable.data} />
        ))}
    </section>
  );
}

function TeamMemberUsageContent({
  loadable,
  range,
}: {
  loadable: UsageMembersLoadable;
  range: UsageRecordRange;
}) {
  const { t } = useTranslation();
  const membersLoadable = useLoadable(orgMembers$);
  const orgMembersList =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const memberMap = new Map<string, OrgMember>(
    orgMembersList.map((member) => {
      return [member.userId, member];
    }),
  );

  return (
    <section className="flex flex-col gap-4">
      {loadable.state === "loading" && <UsageRecordSkeleton />}
      {loadable.state === "hasError" && (
        <p className="text-sm text-muted-foreground" role="alert">
          {t(($) => {
            return $.usage.records.teamLoadError;
          })}
        </p>
      )}
      {loadable.state === "hasData" &&
        (!loadable.data.period ? (
          <UsageRecordEmpty
            title={t(($) => {
              return $.usage.records.empty.noBillingPeriodTitle;
            })}
            description={t(($) => {
              return $.usage.records.empty.noBillingPeriodDescription;
            })}
          />
        ) : loadable.data.members.length === 0 ? (
          <UsageRecordEmpty
            title={emptyTitle(range)}
            description={t(($) => {
              return $.usage.records.empty.teamDescription;
            })}
          />
        ) : (
          <MemberUsageTable
            members={loadable.data.members}
            memberMap={memberMap}
          />
        ))}
    </section>
  );
}

export function PersonalUsageRecord({ range }: { range: UsageRecordRange }) {
  const loadable = useLastLoadable(myUsageRecordAsync$);
  return <UsageRecordContent loadable={loadable} range={range} />;
}

export function TeamUsageRecord({ range }: { range: UsageRecordRange }) {
  const loadable = useLastLoadable(teamMemberUsageAsync$);
  return <TeamMemberUsageContent loadable={loadable} range={range} />;
}

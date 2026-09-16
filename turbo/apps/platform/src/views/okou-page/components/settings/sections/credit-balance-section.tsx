import type { ReactNode } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import type { OrgMember } from "@okouai/api-contracts/contracts/org-members";
import type { UsagePackCreditsResponse } from "@okouai/api-contracts/contracts/billing";
import { ArrowRight, ChevronRight, Loader2, Users } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import {
  CreditAdditionTable,
  CreditBalanceCard,
  formatCreditDate,
  type CreditAddition,
} from "../../org-manage/org-usage-tab.tsx";
import { emptyUsageImg } from "../../../platform-assets.ts";
import { UserAvatar } from "../../../../components/avatar.tsx";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { orgMembers$ } from "../../../../../signals/external/org-members.ts";
import { usagePackCreditsAsync$ } from "../../../../../signals/okou-page/billing.ts";
import { orgPlanCapabilities$ } from "../../../../../signals/okou-page/org-plan-capabilities.ts";
import {
  openSettingsUsagePackConfiguration$,
  settingsDialogSignal$,
  setSettingsActiveSection$,
} from "../../../../../signals/okou-page/settings/settings-dialog.ts";
import {
  requestBuyCreditsScroll$,
  setBillingSubPage$,
} from "../../../../../signals/okou-page/settings/workspace-settings-state.ts";
import {
  closeUsagePackMembersDialog$,
  completeUsagePackMembersDialogClose$,
  openUsagePackMembersDialog$,
  toggleUsagePackMemberAdditions$,
  usagePackMemberAdditionsExpandedMemberId$,
  usagePackMembersDialogOpen$,
} from "../../../../../signals/okou-page/settings/personal-usage-record.ts";
import { formatLocalizedNumber } from "../../../../../i18n/format.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";

interface UsagePackSegment {
  readonly key: "purchased" | "bonus";
  readonly credits: number;
  readonly label: string;
  readonly color: string;
  readonly expiresAt: string | undefined;
}

type UsagePackMemberCredit = NonNullable<
  UsagePackCreditsResponse["memberCredits"]
>[number];

function earliestExpiry(
  data: UsagePackCreditsResponse,
  grantType: UsagePackSegment["key"],
): string | undefined {
  return data.creditGrants
    .filter((grant) => {
      return grant.grantType === grantType;
    })
    .map((grant) => {
      return grant.expiresAt;
    })
    .sort()[0];
}

function usagePackSegments(
  data: UsagePackCreditsResponse,
  purchasedLabel: string,
  bonusLabel: string,
): readonly UsagePackSegment[] {
  const segments: readonly UsagePackSegment[] = [
    {
      key: "purchased",
      credits: data.purchasedCredits,
      label: purchasedLabel,
      color: "bg-credit-plan-pro",
      expiresAt: earliestExpiry(data, "purchased"),
    },
    {
      key: "bonus",
      credits: data.bonusCredits,
      label: bonusLabel,
      color: "bg-credit-promotional",
      expiresAt: earliestExpiry(data, "bonus"),
    },
  ];
  return segments.filter((segment) => {
    return segment.credits > 0;
  });
}

function usagePackCreditAdditions(
  data: UsagePackCreditsResponse,
  purchasedLabel: string,
  bonusLabel: string,
): readonly CreditAddition[] {
  return data.creditGrants.map((grant) => {
    return {
      ...grant,
      label: grant.grantType === "purchased" ? purchasedLabel : bonusLabel,
    };
  });
}

function UsagePackSegmentBar({
  segments,
  testIdPrefix,
  totalCredits,
}: {
  segments: readonly UsagePackSegment[];
  testIdPrefix: string;
  totalCredits: number;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={100}>
      <div
        data-testid={`${testIdPrefix}-bar`}
        className="mt-4 flex h-2 w-full gap-[3px]"
      >
        {segments.map((segment) => {
          const formattedCredits = formatLocalizedNumber(segment.credits);
          const expiryLabel = segment.expiresAt
            ? t(
                ($) => {
                  return $.billing.usage.expires;
                },
                { date: formatCreditDate(segment.expiresAt) },
              )
            : undefined;
          const accessibleLabel = expiryLabel
            ? `${segment.label} — ${formattedCredits}. ${expiryLabel}`
            : `${segment.label} — ${formattedCredits}`;
          return (
            <Tooltip key={segment.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid={`${testIdPrefix}-${segment.key}`}
                  aria-label={accessibleLabel}
                  className={`h-2 ${segment.color} cursor-default first:rounded-l-full last:rounded-r-full ring-0 outline-none transition-shadow hover:z-10 hover:ring-2 hover:ring-foreground/30 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-foreground/30`}
                  style={{
                    width: `${(segment.credits / totalCredits) * 100}%`,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={8}
                style={{
                  backgroundColor: "hsl(var(--popover))",
                  color: "hsl(var(--popover-foreground))",
                }}
                className="border shadow-md"
              >
                <div className="font-medium text-foreground">
                  {segment.label} — {formattedCredits}
                </div>
                {expiryLabel ? (
                  <div className="mt-0.5 text-muted-foreground">
                    {expiryLabel}
                  </div>
                ) : null}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function UsagePackCreditDetails({
  data,
  testIdPrefix = "usage-pack-credit",
}: {
  data: UsagePackCreditsResponse;
  testIdPrefix?: string;
}) {
  const { t } = useTranslation();
  const purchasedLabel = t(($) => {
    return $.billing.usage.usagePack.purchased;
  });
  const bonusLabel = t(($) => {
    return $.billing.usage.usagePack.bonus;
  });
  const segments = usagePackSegments(data, purchasedLabel, bonusLabel);
  const additions = usagePackCreditAdditions(data, purchasedLabel, bonusLabel);

  return (
    <>
      {data.totalCredits > 0 && segments.length > 0 ? (
        <UsagePackSegmentBar
          segments={segments}
          testIdPrefix={testIdPrefix}
          totalCredits={data.totalCredits}
        />
      ) : null}
      <CreditAdditionTable
        grants={additions}
        testIdPrefix={`${testIdPrefix}-grants`}
      />
    </>
  );
}

function UsagePackCreditTitle() {
  const { t } = useTranslation();
  return (
    <p className="text-sm font-semibold text-foreground">
      {t(($) => {
        return $.billing.usage.usagePack.title;
      })}
    </p>
  );
}

function UsagePackCreditHeader({
  action,
  totalCredits,
}: {
  action?: ReactNode;
  totalCredits: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex items-center gap-1">
        <UsagePackCreditTitle />
        {action}
      </div>
      <p className="text-xl font-medium tabular-nums text-foreground">
        {formatLocalizedNumber(totalCredits)}
      </p>
    </div>
  );
}

function usagePackMemberName(member: OrgMember): string {
  const fullName = [member.firstName, member.lastName]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join(" ");
  return fullName || member.email;
}

function emptyMemberCredits(memberId: string): UsagePackMemberCredit {
  return {
    memberId,
    totalCredits: 0,
    purchasedCredits: 0,
    bonusCredits: 0,
    creditGrants: [],
  };
}

interface UsagePackMemberRow {
  readonly member: OrgMember;
  readonly credits: UsagePackMemberCredit;
}

function UsagePackMemberHeader({
  credits,
  member,
}: {
  credits: UsagePackMemberCredit;
  member: OrgMember;
}) {
  const name = usagePackMemberName(member);
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <UserAvatar imageUrl={member.imageUrl} name={name} initial={initial} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          {name !== member.email ? (
            <p className="truncate text-xs text-muted-foreground">
              {member.email}
            </p>
          ) : null}
        </div>
      </div>
      <p className="shrink-0 text-xl font-medium tabular-nums text-foreground">
        {formatLocalizedNumber(credits.totalCredits)}
      </p>
    </div>
  );
}

function UsagePackMemberCreditAdditions({
  expanded,
  grants,
  memberId,
  testIdPrefix,
}: {
  expanded: boolean;
  grants: readonly CreditAddition[];
  memberId: string;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  const toggleExpanded = useSet(toggleUsagePackMemberAdditions$);
  const creditAdditionsLabel = t(($) => {
    return $.billing.usage.creditAdditions;
  });
  if (grants.length === 0) {
    return null;
  }
  return (
    <div className="mt-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid={`${testIdPrefix}-grants-toggle`}
        className="-mx-2 h-8 w-[calc(100%+1rem)] justify-between px-2"
        aria-expanded={expanded}
        aria-label={`${creditAdditionsLabel}: ${grants.length}`}
        onClick={() => {
          toggleExpanded(memberId);
        }}
      >
        <span className="text-sm font-semibold text-foreground">
          {creditAdditionsLabel}
        </span>
        <ChevronRight
          size={13}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
        />
      </Button>
      {expanded ? (
        <div data-testid={`${testIdPrefix}-grants-expanded-row`}>
          <CreditAdditionTable
            grants={grants}
            showHeading={false}
            testIdPrefix={`${testIdPrefix}-grants`}
          />
        </div>
      ) : null}
    </div>
  );
}

function UsagePackMemberCard({ row }: { row: UsagePackMemberRow }) {
  const { t } = useTranslation();
  const expandedMemberId = useGet(usagePackMemberAdditionsExpandedMemberId$);
  const { member, credits } = row;
  const testIdPrefix = `usage-pack-member-${member.userId}`;
  const purchasedLabel = t(($) => {
    return $.billing.usage.usagePack.purchased;
  });
  const bonusLabel = t(($) => {
    return $.billing.usage.usagePack.bonus;
  });
  const grants = usagePackCreditAdditions(credits, purchasedLabel, bonusLabel);
  const segments = usagePackSegments(credits, purchasedLabel, bonusLabel);
  const expanded = expandedMemberId === member.userId;
  return (
    <div
      role="listitem"
      data-testid={`usage-pack-member-credit-${member.userId}`}
      className="overflow-hidden rounded-xl bg-card border border-surface-border"
    >
      <div className="px-5 py-4">
        <UsagePackMemberHeader credits={credits} member={member} />

        {credits.totalCredits > 0 && segments.length > 0 ? (
          <UsagePackSegmentBar
            segments={segments}
            testIdPrefix={testIdPrefix}
            totalCredits={credits.totalCredits}
          />
        ) : null}
        <UsagePackMemberCreditAdditions
          expanded={expanded}
          grants={grants}
          memberId={member.userId}
          testIdPrefix={testIdPrefix}
        />
      </div>
    </div>
  );
}

function UsagePackMemberList({
  rows,
}: {
  rows: readonly UsagePackMemberRow[];
}) {
  const { t } = useTranslation();
  return (
    <div
      role="list"
      aria-label={t(($) => {
        return $.billing.usage.usagePack.members;
      })}
      className="space-y-3"
    >
      {rows.map((row) => {
        return <UsagePackMemberCard key={row.member.userId} row={row} />;
      })}
    </div>
  );
}

function UsagePackMemberBalances({
  memberCredits,
  members,
}: {
  memberCredits: NonNullable<UsagePackCreditsResponse["memberCredits"]>;
  members: readonly OrgMember[];
}) {
  const creditsByMember = new Map(
    memberCredits.map((credits) => {
      return [credits.memberId, credits] as const;
    }),
  );
  const rows = members.map((member) => {
    return {
      member,
      credits:
        creditsByMember.get(member.userId) ?? emptyMemberCredits(member.userId),
    };
  });
  return <UsagePackMemberList rows={rows} />;
}

function UsagePackMemberBalancesDialog({
  memberCredits,
}: {
  memberCredits: NonNullable<UsagePackCreditsResponse["memberCredits"]>;
}) {
  const { t } = useTranslation();
  const membersLoadable = useLoadable(orgMembers$);
  const settingsDialogSignal = useGet(settingsDialogSignal$);
  const open = useGet(usagePackMembersDialogOpen$);
  const openDialog = useSet(openUsagePackMembersDialog$);
  const closeDialog = useSet(closeUsagePackMembersDialog$);
  const completeClose = useSet(completeUsagePackMembersDialogClose$);
  if (
    !settingsDialogSignal ||
    membersLoadable.state !== "hasData" ||
    membersLoadable.data.length <= 1
  ) {
    return null;
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeDialog();
        }
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          completeClose();
        }
      }}
    >
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label={t(($) => {
                return $.billing.usage.usagePack.viewMembers;
              })}
              onClick={() => {
                openDialog(settingsDialogSignal);
              }}
            >
              <Users size={15} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t(($) => {
              return $.billing.usage.usagePack.viewMembers;
            })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
        maxWidth="3xl"
        contentClassName="flex flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b border-border/70 px-6 pb-4 pt-6">
          <DialogTitle>
            {t(($) => {
              return $.billing.usage.usagePack.membersTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.billing.usage.usagePack.membersDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <div
          data-testid="usage-pack-members-dialog-scroll-area"
          className="min-h-0 overflow-y-auto px-6 py-5"
        >
          <UsagePackMemberBalances
            memberCredits={memberCredits}
            members={membersLoadable.data}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UsagePackCreditActions({
  loading,
  onConfigure,
}: {
  loading: boolean;
  onConfigure: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="-mx-5 -mb-4 mt-4 flex items-center justify-end gap-3 border-t border-border px-5 py-[18px]">
      <Button
        type="button"
        variant="default"
        size="sm"
        data-testid="usage-pack-credit-configure"
        disabled={loading}
        onClick={onConfigure}
      >
        {loading ? <Loader2 className="animate-spin" /> : null}
        {t(($) => {
          return $.billing.plans.usagePacks.configurePackages;
        })}
      </Button>
    </div>
  );
}

function UsagePackCreditCard({ isAdmin }: { isAdmin: boolean }) {
  const pageSignal = useGet(pageSignal$);
  const [configureLoadable, openConfiguration] = useLoadableSet(
    openSettingsUsagePackConfiguration$,
  );
  const creditsLoadable = useLoadable(usagePackCreditsAsync$);
  if (creditsLoadable.state === "hasError") {
    return null;
  }
  const data =
    creditsLoadable.state === "hasData" ? creditsLoadable.data : null;

  return (
    <div
      data-testid="usage-pack-credit-card"
      className="overflow-hidden rounded-xl bg-card px-5 py-4 border border-surface-border"
    >
      {creditsLoadable.state === "loading" && !data ? (
        <div className="space-y-2">
          <div className="h-4 w-48 animate-pulse rounded bg-muted/50" />
          <div className="h-2 w-full animate-pulse rounded-full bg-muted/40" />
        </div>
      ) : data ? (
        <>
          <UsagePackCreditHeader
            action={
              isAdmin && data.memberCredits !== undefined ? (
                <UsagePackMemberBalancesDialog
                  memberCredits={data.memberCredits}
                />
              ) : undefined
            }
            totalCredits={data.totalCredits}
          />
          <UsagePackCreditDetails data={data} />
          {isAdmin ? (
            <UsagePackCreditActions
              loading={configureLoadable.state === "loading"}
              onConfigure={() => {
                detach(openConfiguration(pageSignal), Reason.DomCallback);
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CreditBalanceEmptyState() {
  return (
    <div
      data-testid="credit-balance-empty"
      className="flex min-h-[20rem] items-center justify-center px-6"
    >
      <img
        src={emptyUsageImg}
        alt=""
        role="presentation"
        loading="lazy"
        className="h-24 w-24 object-contain opacity-80"
      />
    </div>
  );
}

export function CreditBalanceSection() {
  const { t } = useTranslation();
  const setActiveSection = useSet(setSettingsActiveSection$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const requestBuyCredits = useSet(requestBuyCreditsScroll$);
  const capabilities = useLastResolved(orgPlanCapabilities$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const goToComparePlans = () => {
    setActiveSection("billing");
    setBillingSubPage(true);
  };

  const goToBuyCredits = () => {
    requestBuyCredits();
    setActiveSection("billing");
  };

  const usagePackCreditCard = capabilities?.showUsagePack ? (
    <UsagePackCreditCard isAdmin={isAdmin} />
  ) : null;

  const creditCard = (
    <CreditBalanceCard
      onBuyCredits={goToBuyCredits}
      onComparePlans={goToComparePlans}
    />
  );

  // Members only see credits assigned by their usage pack. Organization
  // balances remain available to organization admins.
  if (!isAdmin) {
    const showEmptyState =
      isAdminLoadable.state === "hasData" && capabilities !== undefined;
    return (
      <div>
        {usagePackCreditCard ??
          (showEmptyState ? <CreditBalanceEmptyState /> : null)}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {usagePackCreditCard}
      {creditCard}
      <button
        type="button"
        data-testid="credit-balance-see-usage"
        className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => {
          setActiveSection("usage-records");
        }}
      >
        {t(($) => {
          return $.billing.usage.seeUsageRecords;
        })}
        <ArrowRight size={13} className="shrink-0" />
      </button>
    </div>
  );
}

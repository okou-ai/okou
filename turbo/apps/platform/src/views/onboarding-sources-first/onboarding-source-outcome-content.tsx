import type { ReactNode } from "react";
import { CircleDot, GitMerge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";

function OutcomeContext({ children }: { readonly children: ReactNode }) {
  return (
    <p className="mb-2.5 text-[10px] leading-4 text-[#858c96]">{children}</p>
  );
}

function BriefRows({
  context,
  rows,
}: {
  readonly context: string;
  readonly rows: readonly (readonly [string, string])[];
}) {
  return (
    <div>
      <OutcomeContext>{context}</OutcomeContext>
      <dl className="grid gap-1.5 text-[11px] leading-5 @max-[380px]:text-[10px]">
        {rows.map(([label, value]) => {
          return (
            <div
              key={label}
              className="grid grid-cols-[54px_minmax(0,1fr)] gap-2 @max-[380px]:grid-cols-[48px_minmax(0,1fr)]"
            >
              <dt className="text-[#8a919a]">{label}</dt>
              <dd>{value}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function TaskRows({
  context,
  rows,
}: {
  readonly context: string;
  readonly rows: readonly (readonly [string, string?])[];
}) {
  return (
    <div>
      <OutcomeContext>{context}</OutcomeContext>
      <ul className="grid gap-1.5 text-[11px] leading-5 @max-[280px]:text-[10px]">
        {rows.map(([task, due]) => {
          return (
            <li className="flex items-center gap-2" key={task}>
              <span
                aria-hidden="true"
                className="size-[13px] shrink-0 rounded-[3px] border border-[#c6cdd6]"
              />
              <span>{task}</span>
              {due && (
                <span className="ml-auto text-[9px] text-[#858c96]">{due}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MarketingOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.marketing;
    },
    { returnObjects: true },
  );
  return (
    <div>
      <div className="mb-2.5 flex items-center justify-between gap-2.5 text-[10px] leading-4 text-[#858c96]">
        <span>{copy.period}</span>
        <span className="text-[9px]">{copy.comparison}</span>
      </div>
      <dl className="space-y-1">
        {[
          ["CPC", "$0.84", "−8.7%"],
          ["CTR", "3.2%", "+14.3%"],
          ["ROAS", "4.1×", "+17.1%"],
        ].map(([label, value, change]) => {
          return (
            <div
              key={label}
              className="grid grid-cols-[minmax(0,1fr)_auto_64px] items-center gap-4 text-[11px] leading-5 not-first:border-t not-first:border-[#f0f3f6] not-first:pt-1 @max-[380px]:grid-cols-[minmax(0,1fr)_auto_56px] @max-[380px]:gap-2.5"
            >
              <dt className="text-[#626974]">{label}</dt>
              <dd className="text-right text-sm font-medium tabular-nums">
                {value}
              </dd>
              <dd className="text-right text-[10px] text-[#5a806e] tabular-nums">
                {change}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function DesignOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.design;
    },
    { returnObjects: true },
  );
  return (
    <div className="grid gap-3 @max-[380px]:gap-2.5">
      <div>
        <p className="text-xs leading-5 font-medium @max-[280px]:text-[11px]">
          {copy.project}
        </p>
        <p className="mt-1 text-[11px] leading-[18px] text-[#626974] @max-[280px]:text-[10px] @max-[280px]:leading-[17px]">
          {copy.positioning}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-4 @max-[380px]:gap-3">
        {[
          [copy.deliverables, copy.scope],
          [copy.direction, copy.visuals],
        ].map(([label, value]) => {
          return (
            <div key={label} className="min-w-0">
              <dt className="text-[10px] leading-[14px] text-[#8a919a]">
                {label}
              </dt>
              <dd className="mt-1 text-[11px] leading-[18px] @max-[380px]:text-[10px]">
                {value}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function ConsultingOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.consulting;
    },
    { returnObjects: true },
  );
  return (
    <BriefRows
      context={copy.context}
      rows={[
        [copy.goal, copy.objective],
        [copy.background, copy.expansion],
        [copy.discuss, copy.agenda],
      ]}
    />
  );
}

function CoachingOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.coaching;
    },
    { returnObjects: true },
  );
  return (
    <div>
      <OutcomeContext>{copy.context}</OutcomeContext>
      <ol className="grid gap-1.5 text-[11px] leading-5">
        {[
          [copy.reviewTime, copy.review],
          [copy.practiceTime, copy.practice],
          [copy.nextTime, copy.next],
        ].map(([time, step]) => {
          return (
            <li
              key={step}
              className="grid grid-cols-[46px_minmax(0,1fr)] items-center gap-3 @max-[280px]:grid-cols-[40px_minmax(0,1fr)] @max-[280px]:gap-2 @max-[280px]:text-[10px]"
            >
              <span className="text-[10px] text-[#6682a8]">{time}</span>
              <span>{step}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FinanceOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.finance;
    },
    { returnObjects: true },
  );
  return (
    <div>
      <OutcomeContext>{copy.context}</OutcomeContext>
      <dl className="space-y-1">
        {[
          [copy.income, "$24,800"],
          [copy.expenses, "$16,200"],
          [copy.reconcile, copy.transactions],
        ].map(([label, value]) => {
          return (
            <div
              key={label}
              className="flex items-center justify-between gap-3.5 text-[11px] leading-5 not-first:border-t not-first:border-[#f0f3f6] not-first:pt-1"
            >
              <dt className="text-[#626974]">{label}</dt>
              <dd className="text-right font-medium tabular-nums">{value}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function OperationsOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.operations;
    },
    { returnObjects: true },
  );
  return (
    <TaskRows
      context={copy.context}
      rows={[
        [copy.quote, copy.today],
        [copy.agenda, copy.tuesday],
        [copy.update, copy.friday],
      ]}
    />
  );
}

function SalesOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.sales;
    },
    { returnObjects: true },
  );
  return (
    <div>
      <OutcomeContext>{copy.context}</OutcomeContext>
      <dl className="grid gap-1.5 text-[11px] leading-5">
        {[
          [copy.acme, copy.proposal],
          [copy.northstar, copy.demo],
        ].map(([company, status]) => {
          return (
            <div
              key={company}
              className="flex items-center justify-between gap-3"
            >
              <dt>{company}</dt>
              <dd className="text-right text-[10px] text-[#858c96]">
                {status}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-2.5 border-t border-[#eef1f5] pt-2 text-[10px] leading-4 text-[#858c96]">
        {copy.next}
      </p>
    </div>
  );
}

function SoftwareOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.software;
    },
    { returnObjects: true },
  );
  return (
    <div>
      <OutcomeContext>{copy.context}</OutcomeContext>
      <ul className="grid gap-1.5 text-[11px] leading-5">
        {[copy.signup, copy.search].map((item) => {
          return (
            <li className="flex items-center gap-2" key={item}>
              <GitMerge
                aria-hidden="true"
                className="size-3.5 shrink-0 text-[#7594bf]"
              />
              <span>{item}</span>
            </li>
          );
        })}
        <li className="flex items-center gap-2">
          <CircleDot
            aria-hidden="true"
            className="size-3.5 shrink-0 text-[#b89763]"
          />
          <span>{copy.issue}</span>
        </li>
      </ul>
    </div>
  );
}

function ResearchOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.research;
    },
    { returnObjects: true },
  );
  return (
    <BriefRows
      context={copy.context}
      rows={[
        [copy.finding, copy.insight],
        [copy.evidence, copy.interviews],
        [copy.next, copy.action],
      ]}
    />
  );
}

function InvestingOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.investing;
    },
    { returnObjects: true },
  );
  return (
    <div>
      <table className="w-full table-fixed border-collapse text-[10px] leading-5 @max-[280px]:text-[9px]">
        <thead>
          <tr>
            <th
              scope="col"
              className="w-[48%] pb-2 text-left font-normal text-[#858c96]"
            >
              {copy.metric}
            </th>
            {[copy.acme, copy.northstar].map((company) => {
              return (
                <th
                  scope="col"
                  key={company}
                  className="pb-2 text-right font-normal text-[#858c96]"
                >
                  {company}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {[
            [copy.growth, "+18%", "+12%"],
            [copy.margin, "72%", "64%"],
          ].map(([metric, acme, northstar]) => {
            return (
              <tr key={metric}>
                <th scope="row" className="pt-1 text-left font-normal">
                  {metric}
                </th>
                <td className="pt-1 text-right tabular-nums">{acme}</td>
                <td className="pt-1 text-right tabular-nums">{northstar}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2.5 border-t border-[#eef1f5] pt-2 text-[10px] leading-4 text-[#858c96]">
        {copy.watch}
      </p>
    </div>
  );
}

function OtherOutcome() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.other;
    },
    { returnObjects: true },
  );
  return (
    <TaskRows
      context={copy.context}
      rows={[[copy.reply], [copy.brief], [copy.call]]}
    />
  );
}

const OUTCOME_CONTENT = {
  marketing: MarketingOutcome,
  design: DesignOutcome,
  consulting: ConsultingOutcome,
  coaching: CoachingOutcome,
  finance: FinanceOutcome,
  operations: OperationsOutcome,
  sales: SalesOutcome,
  software: SoftwareOutcome,
  research: ResearchOutcome,
  investing: InvestingOutcome,
  other: OtherOutcome,
} satisfies Record<OnboardingIndustry, () => ReactNode>;

export function OnboardingSourceOutcomeContent({
  industry,
}: {
  readonly industry: OnboardingIndustry;
}) {
  const Content = OUTCOME_CONTENT[industry];
  return <Content />;
}

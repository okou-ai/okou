import type { ReactNode } from "react";
import { Check, ChevronRight, FileText, Mail, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui/lib/utils";
import type { WorkflowRecommendationId } from "../../signals/okou-page/composer-workflow-recommendations.ts";

const PREVIEW_COLORS = {
  morning: "bg-violet-50 dark:bg-violet-950/30",
  meetings: "bg-green-50 dark:bg-green-950/30",
  inbox: "bg-orange-50 dark:bg-orange-950/30",
  weekly: "bg-indigo-50 dark:bg-indigo-950/30",
  recap: "bg-blue-50 dark:bg-blue-950/30",
  invoices: "bg-amber-50 dark:bg-amber-950/30",
  competitors: "bg-rose-50 dark:bg-rose-950/30",
  metrics: "bg-emerald-50 dark:bg-emerald-950/30",
  reply: "bg-sky-50 dark:bg-sky-950/30",
} satisfies Record<WorkflowRecommendationId, string>;

function CheckLine({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex items-start gap-1.5">
      <Check
        className="mt-0.5 size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      />
      <span>{children}</span>
    </span>
  );
}

function MorningPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.morning;
    },
    { returnObjects: true },
  );
  return (
    <>
      <span className="block text-lg font-medium">{copy.heading}</span>
      <span className="flex flex-col gap-1 rounded-md bg-violet-50 p-2 dark:bg-violet-950/40">
        <span className="font-medium">{copy.priority}</span>
        <span>{copy.task}</span>
      </span>
      <span className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground">10:00</span>
        <span>{copy.meetingOne}</span>
        <span className="text-muted-foreground">14:30</span>
        <span>{copy.meetingTwo}</span>
      </span>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Mail className="size-3" aria-hidden />
        {copy.footer}
      </span>
    </>
  );
}

function MeetingsPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.meetings;
    },
    { returnObjects: true },
  );
  return (
    <>
      <span className="block text-lg font-medium">{copy.heading}</span>
      <span className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
          {copy.initials}
        </span>
        <span>
          <span className="block font-medium">{copy.person}</span>
          <span className="block text-muted-foreground">{copy.role}</span>
        </span>
      </span>
      <span className="flex flex-col gap-1 border-l-2 border-green-200 pl-2 dark:border-green-800">
        <span className="font-medium">{copy.note}</span>
        <span>{copy.question}</span>
      </span>
      <span className="flex flex-wrap gap-2 text-muted-foreground">
        <span>{copy.tagOne}</span>
        <span>·</span>
        <span>{copy.tagTwo}</span>
      </span>
    </>
  );
}

function InboxPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.inbox;
    },
    { returnObjects: true },
  );
  return (
    <>
      <span className="flex items-center justify-between gap-1 border-b border-border pb-1.5">
        <span className="truncate">{copy.subject}</span>
        <span className="shrink-0 rounded bg-orange-50 px-1 py-0.5 text-orange-800 dark:bg-orange-950 dark:text-orange-200">
          {copy.needsReply}
        </span>
      </span>
      <span className="flex justify-between gap-2 border-b border-border pb-2">
        <span>{copy.later}</span>
        <span className="text-muted-foreground">{copy.readLater}</span>
      </span>
      <span className="flex min-w-0 flex-col gap-1 rounded-md border border-orange-200/70 p-1.5 dark:border-orange-800">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Pencil className="size-2.5" aria-hidden />
          {copy.draft}
        </span>
        <span className="font-serif">{copy.text}</span>
        <span className="text-muted-foreground">{copy.review}</span>
      </span>
    </>
  );
}

function WeeklyPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.weekly;
    },
    { returnObjects: true },
  );
  return (
    <>
      <span className="block text-lg font-medium">{copy.heading}</span>
      <CheckLine>{copy.one}</CheckLine>
      <CheckLine>{copy.two}</CheckLine>
      <span className="flex flex-col gap-1 border-t border-border pt-3">
        <span className="text-muted-foreground">{copy.next}</span>
        <span>{copy.task}</span>
      </span>
    </>
  );
}

function RecapPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.recap;
    },
    { returnObjects: true },
  );
  return (
    <>
      <CheckLine>{copy.decision}</CheckLine>
      <span className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground">{copy.task}</span>
        <span className="text-muted-foreground">{copy.owner}</span>
        <span className="text-muted-foreground">{copy.due}</span>
        <span>{copy.one}</span>
        <span>{copy.you}</span>
        <span>{copy.friday}</span>
        <span>{copy.two}</span>
        <span>{copy.team}</span>
        <span>{copy.monday}</span>
        <>
          <span>{copy.three}</span>
          <span>{copy.assign}</span>
          <span>—</span>
        </>
      </span>
    </>
  );
}

function InvoicesPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.invoices;
    },
    { returnObjects: true },
  );
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <FileText
          className="size-6 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden
        />
        <span className="min-w-0">
          <span className="block font-medium">{copy.file}</span>
          <span className="block text-muted-foreground">{copy.path}</span>
        </span>
        <Check
          className="ml-auto size-3 shrink-0 text-emerald-600"
          aria-hidden
        />
      </span>
      <span className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-1.5 gap-y-1 rounded-md bg-amber-50 p-1.5 dark:bg-amber-950/40">
        <span className="text-muted-foreground">{copy.vendor}</span>
        <span className="text-muted-foreground">{copy.amount}</span>
        <span className="text-muted-foreground">{copy.status}</span>
        <span>{copy.example}</span>
        <span>$1,240</span>
        <span>{copy.filed}</span>
        <>
          <span>{copy.second}</span>
          <span>$380</span>
          <span>{copy.filed}</span>
        </>
      </span>
      <span className="text-muted-foreground">{copy.footer}</span>
    </>
  );
}

function CompetitorsPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.competitors;
    },
    { returnObjects: true },
  );
  return (
    <>
      <span className="block text-lg font-medium">{copy.heading}</span>
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 rounded-md border border-rose-200 p-2 dark:border-rose-800">
          <span className="block text-muted-foreground">{copy.previous}</span>
          <span className="mt-1 block text-3xl font-medium text-rose-800 dark:text-rose-200">
            $29 <span className="text-[0.4em]">{copy.unit}</span>
          </span>
        </span>
        <ChevronRight className="hidden size-3 shrink-0 sm:block" aria-hidden />
        <span className="min-w-0 flex-1 rounded-md border border-rose-200 bg-rose-50 p-2 dark:border-rose-800 dark:bg-rose-950/40">
          <span className="block text-muted-foreground">{copy.now}</span>
          <span className="mt-1 block text-3xl font-medium text-rose-800 dark:text-rose-200">
            $39 <span className="text-[0.4em]">{copy.unit}</span>
          </span>
        </span>
      </span>
      <>
        <span>
          {copy.changed}: {copy.plan}
        </span>
        <span className="text-muted-foreground">{copy.footer}</span>
      </>
    </>
  );
}

function MetricsPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.metrics;
    },
    { returnObjects: true },
  );
  return (
    <>
      <span className="text-muted-foreground">{copy.period}</span>
      <span className="grid grid-cols-3 gap-1">
        <span>
          <span className="block text-muted-foreground">{copy.visitors}</span>
          <span className="block text-3xl font-medium text-emerald-800 dark:text-emerald-200">
            1,840
          </span>
          <span>↑ 12%</span>
        </span>
        <span>
          <span className="block text-muted-foreground">{copy.signups}</span>
          <span className="block text-3xl font-medium text-emerald-800 dark:text-emerald-200">
            64
          </span>
          <span>↑ 8%</span>
        </span>
        <span>
          <span className="block text-muted-foreground">{copy.activated}</span>
          <span className="block text-3xl font-medium text-emerald-800 dark:text-emerald-200">
            42
          </span>
          <span>↑ 5%</span>
        </span>
      </span>
      <svg
        viewBox="0 0 300 50"
        className="h-14 w-full text-emerald-600 dark:text-emerald-400"
        aria-hidden
      >
        <path
          d="M0 42L25 37L50 41L75 26L100 30L125 20L150 28L175 12L200 17L225 10L250 14L275 5L300 8L300 50H0Z"
          className="fill-current opacity-10"
        />
        <path
          d="M0 42L25 37L50 41L75 26L100 30L125 20L150 28L175 12L200 17L225 10L250 14L275 5L300 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
      <span className="text-muted-foreground">{copy.footer}</span>
    </>
  );
}

function ReplyPreview() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview.reply;
    },
    { returnObjects: true },
  );
  return (
    <>
      <span className="flex items-start gap-1.5">
        <Mail
          className="mt-0.5 size-3 shrink-0 text-sky-700 dark:text-sky-300"
          aria-hidden
        />
        <span>
          <span className="block font-medium">{copy.heading}</span>
          <span className="block text-muted-foreground">{copy.subject}</span>
        </span>
      </span>
      <span className="block border-l-2 border-sky-200 bg-sky-50 p-1.5 font-serif dark:border-sky-800 dark:bg-sky-950/40">
        {copy.quote}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-muted-foreground">{copy.next}</span>
        <span>{copy.task}</span>
      </span>
    </>
  );
}
const PREVIEW_CONTENT = {
  morning: MorningPreview,
  meetings: MeetingsPreview,
  inbox: InboxPreview,
  weekly: WeeklyPreview,
  recap: RecapPreview,
  invoices: InvoicesPreview,
  competitors: CompetitorsPreview,
  metrics: MetricsPreview,
  reply: ReplyPreview,
} satisfies Record<WorkflowRecommendationId, () => ReactNode>;

/** The sample result a workflow dialog shows: a full-size mock of the thing. */
export function WorkflowResultPreview({
  id,
}: {
  readonly id: WorkflowRecommendationId;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.preview;
    },
    {
      returnObjects: true,
    },
  );
  const sample = t(($) => {
    return $.chat.taskChips.workflows.sample;
  });
  const Preview = PREVIEW_CONTENT[id];

  return (
    <span
      data-slot="workflow-result-preview"
      role="img"
      aria-label={`${sample}: ${copy[id].label}`}
      className={cn(
        "relative block min-w-0 rounded-2xl p-5",
        PREVIEW_COLORS[id],
      )}
    >
      <span className="flex min-h-60 min-w-0 flex-col gap-4 rounded-lg bg-card p-4 text-xs leading-relaxed text-foreground">
        <span className="block text-muted-foreground">{copy[id].label}</span>
        <Preview />
        <span className="mt-auto self-end text-[10px] text-muted-foreground">
          {sample}
        </span>
      </span>
    </span>
  );
}

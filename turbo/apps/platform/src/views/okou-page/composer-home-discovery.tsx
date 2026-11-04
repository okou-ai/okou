import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpLeft,
  Bell,
  ChartNoAxesCombined,
  FileSearch,
  FileText,
  Globe,
  Image,
  ListTodo,
  Newspaper,
  Presentation,
  Search,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { ComposerHomeEntry } from "../../signals/okou-page/composer-home-discovery.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task-chips.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

const SEARCH_ENTRIES = [
  {
    id: "people",
    icon: Users,
    iconClassName: "text-blue-600 dark:text-blue-400",
  },
  {
    id: "information",
    icon: FileSearch,
    iconClassName: "text-amber-600 dark:text-amber-400",
  },
  {
    id: "general",
    icon: Search,
    iconClassName: "text-teal-600 dark:text-teal-400",
  },
] as const;
const CREATE_ENTRIES = [
  { id: "image", icon: Image, iconClassName: "text-artifact-image" },
  {
    id: "presentation",
    icon: Presentation,
    iconClassName: "text-artifact-presentation",
  },
  {
    id: "document",
    icon: FileText,
    iconClassName: "text-violet-600 dark:text-violet-400",
  },
  {
    id: "website",
    icon: Globe,
    iconClassName: "text-cyan-600 dark:text-cyan-400",
  },
  {
    id: "visualization",
    icon: ChartNoAxesCombined,
    iconClassName: "text-rose-600 dark:text-rose-400",
  },
] as const;
const AUTOMATE_ENTRIES = [
  {
    id: "briefs",
    icon: Newspaper,
    iconClassName: "text-orange-600 dark:text-orange-400",
  },
  {
    id: "monitor",
    icon: Bell,
    iconClassName: "text-lime-600 dark:text-lime-400",
  },
] as const;

function EntryButton({
  id,
  icon: Icon,
  children,
  className,
  onClick,
}: {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly className: string;
  readonly onClick: () => void;
}) {
  return (
    <Button
      data-home-entry={id}
      type="button"
      variant="quiet"
      size="sm"
      iconSize="lg"
      className="min-w-0 justify-start gap-2 px-1 text-left text-[0.8125rem] font-normal text-foreground"
      onClick={onClick}
    >
      <Icon className={className} aria-hidden />
      <span className="truncate">{children}</span>
    </Button>
  );
}

function EntryGroup({
  title,
  children,
  columns = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly columns?: boolean;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-start gap-2 py-4 first:pt-0 last:pb-0 @2xl:block @2xl:px-5 @2xl:py-0 @2xl:first:pl-0 @2xl:last:pr-0">
      <h3 className="mt-1 truncate text-[0.8125rem] leading-6 font-semibold text-foreground @2xl:mt-0 @2xl:mb-3">
        {title}
      </h3>
      <div
        className={cn(
          "grid auto-rows-8 gap-x-2 gap-y-1",
          columns && "grid-cols-2",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function HomeDirectory({
  signals,
  tasks,
}: {
  readonly signals: ComposerSignals;
  readonly tasks: readonly ComposerTask[];
}) {
  const { t } = useTranslation();
  const openEntry = useSet(signals.homeDiscovery.openEntry$);
  const openTask = useSet(signals.homeDiscovery.openTask$);
  const entry = ({
    id,
    icon,
    iconClassName,
  }: (typeof SEARCH_ENTRIES)[number] | (typeof AUTOMATE_ENTRIES)[number]) => {
    return (
      <EntryButton
        key={id}
        id={id}
        icon={icon}
        className={iconClassName}
        onClick={() => {
          openEntry(id);
        }}
      >
        {t(($) => {
          return $.chat.homeDiscovery.entries[id].label;
        })}
      </EntryButton>
    );
  };
  // Keep SVG pixel snapping stable when Safari composites nearby animations.
  return (
    <section
      className="@container transform-gpu"
      aria-label={t(($) => {
        return $.chat.homeDiscovery.label;
      })}
    >
      <div className="grid grid-cols-1 divide-y divide-border @2xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] @2xl:divide-x @2xl:divide-y-0">
        <EntryGroup
          title={t(($) => {
            return $.chat.homeDiscovery.groups.search;
          })}
        >
          {SEARCH_ENTRIES.map(entry)}
        </EntryGroup>
        <EntryGroup
          columns
          title={t(($) => {
            return $.chat.homeDiscovery.groups.create;
          })}
        >
          {CREATE_ENTRIES.filter(({ id }) => {
            return tasks.includes(id);
          }).map(({ id, icon, iconClassName }) => {
            return (
              <EntryButton
                key={id}
                id={id}
                icon={icon}
                className={iconClassName}
                onClick={() => {
                  openTask(id);
                }}
              >
                {t(($) => {
                  return $.chat.homeDiscovery.create[id];
                })}
              </EntryButton>
            );
          })}
        </EntryGroup>
        <EntryGroup
          title={t(($) => {
            return $.chat.homeDiscovery.groups.automate;
          })}
        >
          {AUTOMATE_ENTRIES.map(entry)}
          <EntryButton
            id="workflow"
            icon={Workflow}
            className="text-fuchsia-600 dark:text-fuchsia-400"
            onClick={() => {
              openTask("workflow");
            }}
          >
            {t(($) => {
              return $.chat.homeDiscovery.workflows;
            })}
          </EntryButton>
        </EntryGroup>
      </div>
      {tasks.includes("jobs") && (
        <div className="mt-4">
          <EntryButton
            id="jobs"
            icon={ListTodo}
            className="text-slate-500 dark:text-slate-400"
            onClick={() => {
              openTask("jobs");
            }}
          >
            {t(($) => {
              return $.chat.taskChips.tasks.jobs;
            })}
          </EntryButton>
        </div>
      )}
    </section>
  );
}

function HomeIdeas({
  signals,
  entry,
}: {
  readonly signals: ComposerSignals;
  readonly entry: ComposerHomeEntry;
}) {
  const { t } = useTranslation();
  const insertExample = useSet(signals.homeDiscovery.useExample$);
  const signal = useGet(pageSignal$);
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={t(($) => {
        return $.chat.taskChips.ideasLabel;
      })}
    >
      <h3 className="mb-1 text-sm font-medium text-foreground">
        {t(($) => {
          return $.chat.homeDiscovery.entries[entry].title;
        })}
      </h3>
      {(["first", "second", "third"] as const).map((key) => {
        const text = t(($) => {
          return $.chat.homeDiscovery.entries[entry].examples[key];
        });
        return (
          <Button
            key={key}
            type="button"
            variant="quiet"
            size="sm"
            className="h-auto min-h-9 justify-between gap-3 px-2 py-2 text-left text-sm font-normal whitespace-normal"
            onClick={() => {
              detach(insertExample(text, signal), Reason.DomCallback);
            }}
          >
            <span>{text}</span>
            <ArrowUpLeft className="shrink-0" aria-hidden />
          </Button>
        );
      })}
    </section>
  );
}

export function ComposerHomeDiscovery({
  signals,
  tasks,
  children,
}: {
  readonly signals: ComposerSignals;
  readonly tasks: readonly ComposerTask[];
  readonly children: ReactNode;
}) {
  const view = useGet(signals.homeDiscovery.view$);
  const ideasVisible = useGet(signals.homeDiscovery.ideasVisible$);
  if (view === "directory") {
    return <HomeDirectory signals={signals} tasks={tasks} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {view === "task"
        ? children
        : ideasVisible && <HomeIdeas signals={signals} entry={view} />}
    </div>
  );
}

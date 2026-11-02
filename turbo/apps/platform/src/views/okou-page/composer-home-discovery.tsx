import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
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
  { id: "people", icon: Users },
  { id: "information", icon: FileSearch },
  { id: "general", icon: Search },
] as const;
const CREATE_ENTRIES = [
  { id: "image", icon: Image },
  { id: "presentation", icon: Presentation },
  { id: "document", icon: FileText },
  { id: "website", icon: Globe },
  { id: "visualization", icon: ChartNoAxesCombined },
] as const;
const AUTOMATE_ENTRIES = [
  { id: "briefs", icon: Newspaper },
  { id: "monitor", icon: Bell },
] as const;

function EntryButton({
  signals,
  id,
  icon: Icon,
  children,
  className,
  onClick,
}: {
  readonly signals: ComposerSignals;
  readonly id: string;
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly className: string;
  readonly onClick: () => void;
}) {
  const bind = useSet(signals.homeDiscovery.bindDirectoryEntry$);
  return (
    <Button
      ref={bind}
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
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2 py-4 first:pt-0 last:pb-0 @2xl:block @2xl:px-5 @2xl:py-0 @2xl:first:pl-0 @2xl:last:pr-0">
      <h3 className="mt-1 text-[0.8125rem] leading-6 font-semibold text-foreground @2xl:mt-0 @2xl:mb-3">
        {title}
      </h3>
      <div className={cn("grid gap-x-2 gap-y-1", columns && "grid-cols-2")}>
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
  }: (typeof SEARCH_ENTRIES)[number] | (typeof AUTOMATE_ENTRIES)[number]) => {
    return (
      <EntryButton
        key={id}
        signals={signals}
        id={id}
        icon={icon}
        className={
          id === "briefs" || id === "monitor"
            ? "text-lime-700/70"
            : "text-teal-600/80"
        }
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
  return (
    <section
      className="@container"
      aria-label={t(($) => {
        return $.chat.homeDiscovery.label;
      })}
    >
      <div className="grid grid-cols-1 divide-y divide-border @2xl:grid-cols-3 @2xl:divide-x @2xl:divide-y-0">
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
          }).map(({ id, icon }) => {
            return (
              <EntryButton
                key={id}
                signals={signals}
                id={id}
                icon={icon}
                className="text-violet-500/80"
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
            signals={signals}
            id="workflow"
            icon={Workflow}
            className="text-lime-700/70"
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
            signals={signals}
            id="jobs"
            icon={ListTodo}
            className="text-muted-foreground"
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
  const { t } = useTranslation();
  const view = useGet(signals.homeDiscovery.view$);
  const ideasVisible = useGet(signals.homeDiscovery.ideasVisible$);
  const showDirectory = useSet(signals.homeDiscovery.showDirectory$);
  if (view === "directory") {
    return <HomeDirectory signals={signals} tasks={tasks} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="w-fit -ml-2"
        onClick={showDirectory}
      >
        <ArrowLeft aria-hidden />
        {t(($) => {
          return $.chat.homeDiscovery.allEntries;
        })}
      </Button>
      {view === "task"
        ? children
        : ideasVisible && <HomeIdeas signals={signals} entry={view} />}
    </div>
  );
}

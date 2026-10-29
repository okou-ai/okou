import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import {
  ChartNoAxesCombined,
  ChevronDown,
  FileText,
  Globe,
  Image,
  Lightbulb,
  ListTodo,
  Presentation,
  Route,
} from "lucide-react";
import {
  Button,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  LayoutPanel,
  TabsList,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task-chips.ts";
import { sidebarOff$ } from "../../signals/okou-page/nav.ts";
import {
  chatListWidth$,
  unifiedChatWorkspace$,
} from "../../signals/okou-page/unified-chat-workspace.ts";

const TASK_CHIP = "shrink-0 px-3";
const TASK_ICONS = {
  jobs: ListTodo,
  suggestions: Lightbulb,
  workflow: Route,
  presentation: Presentation,
  document: FileText,
  image: Image,
  website: Globe,
  visualization: ChartNoAxesCombined,
} as const;

function TaskOverflowIcons({
  tasks,
}: {
  readonly tasks: readonly ComposerTask[];
}) {
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      <span className="isolate flex shrink-0 items-center">
        {tasks.slice(0, 3).map((task) => {
          const Icon = TASK_ICONS[task];
          return (
            <span
              key={task}
              className="-ml-1.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-gray-300 bg-card text-muted-foreground first:ml-0"
            >
              <Icon size={16} />
            </span>
          );
        })}
      </span>
      {tasks.length > 3 && (
        <span className="ml-1.5 text-xs font-medium tabular-nums text-muted-foreground">
          +{tasks.length - 3}
        </span>
      )}
    </span>
  );
}

function TaskChipSizing({
  tasks,
  labels,
}: {
  readonly tasks: readonly ComposerTask[];
  readonly labels: Readonly<Record<ComposerTask, string>>;
}) {
  return (
    <div
      className="pointer-events-none invisible absolute inset-0 overflow-hidden"
      aria-hidden
      inert
    >
      <div data-task-sizing="" className="flex w-max items-center gap-2 p-1">
        {tasks.map((task) => {
          const Icon = TASK_ICONS[task];
          return (
            <span
              key={task}
              data-task-sizing-item=""
              data-priority={task === "suggestions" ? "" : undefined}
              className={cn(buttonVariants({ variant: "outline" }), TASK_CHIP)}
            >
              <Icon size={16} aria-hidden />
              {labels[task]}
            </span>
          );
        })}
        {tasks.map((task, index) => {
          return (
            <span
              key={task}
              data-more-sizing={index + 1}
              className={cn(buttonVariants({ variant: "outline" }), TASK_CHIP)}
            >
              <TaskOverflowIcons
                tasks={tasks.slice(tasks.length - index - 1)}
              />
              <ChevronDown size={16} aria-hidden />
            </span>
          );
        })}
      </div>
    </div>
  );
}

function TaskChip({
  task,
  label,
  tabs,
  onSelect,
}: {
  readonly task: ComposerTask;
  readonly label: string;
  readonly tabs: boolean;
  readonly onSelect: (task: ComposerTask) => void;
}) {
  const Icon = TASK_ICONS[task];
  const content = (
    <>
      <Icon size={16} className="text-muted-foreground" aria-hidden />
      {label}
    </>
  );
  return tabs ? (
    <TabsPrimitive.Tab
      value={task}
      className="data-active:bg-segment-selected data-active:shadow-segment-selected"
      render={<Button type="button" variant="outline" className={TASK_CHIP} />}
    >
      {content}
    </TabsPrimitive.Tab>
  ) : (
    <Button
      type="button"
      variant="outline"
      className={TASK_CHIP}
      onClick={() => {
        return onSelect(task);
      }}
    >
      {content}
    </Button>
  );
}

function TaskOverflowMenu({
  tasks,
  labels,
  more,
  onSelect,
  finalFocus,
}: {
  readonly tasks: readonly ComposerTask[];
  readonly labels: Readonly<Record<ComposerTask, string>>;
  readonly more: string;
  readonly onSelect: (task: ComposerTask) => void;
  readonly finalFocus: () => boolean;
}) {
  return (
    <DropdownMenu>
      <TooltipProvider delay={300}>
        <Tooltip>
          <DropdownMenuTrigger
            render={
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className={TASK_CHIP}
                    aria-label={more}
                  />
                }
              />
            }
          >
            <TaskOverflowIcons tasks={tasks} />
            <ChevronDown
              size={16}
              className="text-muted-foreground"
              aria-hidden
            />
          </DropdownMenuTrigger>
          <TooltipContent className="max-w-64">
            {tasks
              .map((task) => {
                return labels[task];
              })
              .join(", ")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent
        align="end"
        className="min-w-48"
        finalFocus={finalFocus}
      >
        {tasks.map((task) => {
          const Icon = TASK_ICONS[task];
          return (
            <DropdownMenuItem
              key={task}
              onClick={() => {
                return onSelect(task);
              }}
            >
              <Icon className="text-muted-foreground" aria-hidden />
              {labels[task]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ComposerTaskChipRow({
  signals,
  tasks,
  tabs = false,
}: {
  readonly signals: ComposerSignals;
  readonly tasks: readonly ComposerTask[];
  readonly tabs?: boolean;
}) {
  const { t } = useTranslation();
  const labels = t(
    ($) => {
      return $.chat.taskChips.tasks;
    },
    { returnObjects: true },
  );
  const more = t(($) => {
    return $.chat.taskChips.more;
  });
  const hidden = useGet(signals.taskChips.overflow.hiddenTaskIndices$);
  const hiddenTasks = tasks.filter((_, index) => {
    return hidden.includes(index);
  });
  const bindRoot = useSet(signals.taskChips.overflow.bindRoot$);
  const measure = useSet(signals.taskChips.overflow.measure$);
  const selectTask = useSet(signals.taskChips.selectTask$);
  const browseTask = useSet(signals.taskChips.browseTask$);
  const finalFocus = useSet(signals.taskChips.taskMenuFinalFocus$);
  const sidebarHidden = useGet(sidebarOff$);
  const chatListWidth = useGet(chatListWidth$);
  const unified = useGet(unifiedChatWorkspace$);
  const layoutKey = JSON.stringify([
    tasks.map((task) => {
      return [task, labels[task]];
    }),
    sidebarHidden,
    chatListWidth,
    unified,
  ]);

  const select = (task: ComposerTask) => {
    if (task === "suggestions" || task === "jobs") {
      browseTask(task);
    } else {
      selectTask(task);
    }
  };
  const Row = tabs ? TabsList : "div";
  return (
    <LayoutPanel
      active
      layoutKey={layoutKey}
      onLayoutCommit={measure}
      className="-my-1 min-w-0"
    >
      <div ref={bindRoot} className="relative min-w-0" data-task-choices="">
        {/* Inert spans share button geometry, including choices inside More. */}
        <TaskChipSizing tasks={tasks} labels={labels} />
        <div className="mx-auto flex w-max max-w-full items-center gap-2 overflow-hidden p-1">
          <Row
            {...(tabs ? {} : { role: "group" })}
            aria-label={t(($) => {
              return $.chat.taskChips.chooseTask;
            })}
            className="flex h-auto min-w-0 flex-nowrap items-center justify-start gap-2 bg-transparent p-0"
          >
            {tasks.map((task, index) => {
              if (hidden.includes(index)) {
                return null;
              }
              return (
                <TaskChip
                  key={task}
                  task={task}
                  label={labels[task]}
                  tabs={tabs}
                  onSelect={select}
                />
              );
            })}
          </Row>
          {hidden.length > 0 && (
            <TaskOverflowMenu
              tasks={hiddenTasks}
              labels={labels}
              more={more}
              onSelect={select}
              finalFocus={finalFocus}
            />
          )}
        </div>
      </div>
    </LayoutPanel>
  );
}

import { command, computed, state, type Command } from "ccstate";

export const VISUALIZATION_OUTPUTS = [
  "presentation",
  "website",
  "spreadsheet",
  "report",
] as const;

export const VISUALIZATION_CHARTS = [
  "bar",
  "line",
  "pie",
  "scatter",
  "area",
  "stacked-bar",
  "heatmap",
  "bubble",
  "radar",
  "sankey",
  "gantt",
  "bar-race",
  "candlestick",
  "funnel",
  "nested-donut",
  "route-map",
  "choropleth-map",
  "word-cloud",
] as const;

export type VisualizationOutput = (typeof VISUALIZATION_OUTPUTS)[number];
export type VisualizationChart = (typeof VISUALIZATION_CHARTS)[number];

export interface VisualizationPreferences {
  readonly output: VisualizationOutput | null;
  readonly charts: readonly VisualizationChart[];
}

export interface VisualizationSubmission {
  readonly revision: number;
}

interface VisualizationHandoffTarget {
  readonly revision: number;
  readonly clearIfUnchanged$: Command<void, [number]>;
}

export function createComposerVisualizationSignals() {
  const output$ = state<VisualizationOutput | null>(null);
  const charts$ = state<readonly VisualizationChart[]>([]);
  const revision$ = state(0);
  const pendingSubmissions$ = state<
    readonly {
      readonly submission: VisualizationSubmission;
      readonly handoffs: readonly VisualizationHandoffTarget[];
    }[]
  >([]);
  const preferences$ = computed((get): VisualizationPreferences => {
    return {
      output: get(output$),
      charts: get(charts$),
    };
  });
  const setOutput$ = command(({ get, set }, output: VisualizationOutput) => {
    set(output$, get(output$) === output ? null : output);
    set(revision$, get(revision$) + 1);
  });
  const toggleChart$ = command(({ get, set }, chart: VisualizationChart) => {
    const charts = get(charts$);
    set(
      charts$,
      charts.includes(chart)
        ? charts.filter((item) => {
            return item !== chart;
          })
        : [...charts, chart],
    );
    set(revision$, get(revision$) + 1);
  });
  const clearIfUnchanged$ = command(
    ({ get, set }, submittedRevision: number) => {
      if (get(revision$) !== submittedRevision) {
        return;
      }
      set(output$, null);
      set(charts$, []);
      set(revision$, get(revision$) + 1);
    },
  );
  const trackSubmission$ = command(
    ({ get, set }, submission: VisualizationSubmission) => {
      set(pendingSubmissions$, [
        ...get(pendingSubmissions$),
        { submission, handoffs: [] },
      ]);
    },
  );
  const registerHandoff$ = command(
    (
      { get, set },
      submission: VisualizationSubmission,
      target: VisualizationHandoffTarget,
    ) => {
      set(
        pendingSubmissions$,
        get(pendingSubmissions$).map((pending) => {
          return pending.submission === submission
            ? { ...pending, handoffs: [...pending.handoffs, target] }
            : pending;
        }),
      );
    },
  );
  const finishSubmission$ = command(
    ({ get, set }, submission: VisualizationSubmission, accepted: boolean) => {
      const pendingSubmissions = get(pendingSubmissions$);
      set(
        pendingSubmissions$,
        pendingSubmissions.filter((pending) => {
          return pending.submission !== submission;
        }),
      );
      if (!accepted) {
        return;
      }
      set(clearIfUnchanged$, submission.revision);
      for (const pending of pendingSubmissions) {
        if (pending.submission !== submission) {
          continue;
        }
        for (const target of pending.handoffs) {
          set(target.clearIfUnchanged$, target.revision);
        }
      }
    },
  );
  return {
    output$,
    charts$,
    preferences$,
    revision$,
    setOutput$,
    toggleChart$,
    clearIfUnchanged$,
    trackSubmission$,
    registerHandoff$,
    finishSubmission$,
  };
}

export type ComposerVisualizationSignals = ReturnType<
  typeof createComposerVisualizationSignals
>;

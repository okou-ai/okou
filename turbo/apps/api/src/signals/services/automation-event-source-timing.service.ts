import { now } from "../../lib/time";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";

type AutomationEventSource =
  | "github"
  | "gmail"
  | "google_calendar"
  | "google_forms"
  | "google_meet"
  | "webhook";

type AutomationEventSourceTimingActionType = Extract<
  ApiDispatchTimingActionType,
  `api_dispatch_pre_create_agent_automation_event_${string}`
>;

interface AutomationEventSourceTimingRecord {
  readonly actionType: AutomationEventSourceTimingActionType;
  readonly startedAt: number;
  readonly finishedAt: number;
}

function automationEventSourceDimensions(
  source: AutomationEventSource,
): ApiDispatchTimingDimensions {
  return { automation_event_source: source };
}

export class AutomationEventSourceTiming {
  private readonly records: AutomationEventSourceTimingRecord[];

  constructor(
    private readonly source: AutomationEventSource,
    private readonly apiStartTime: number,
    records: readonly AutomationEventSourceTimingRecord[] = [],
  ) {
    this.records = [...records];
  }

  recordElapsed(
    actionType: AutomationEventSourceTimingActionType,
    startedAt: number,
    finishedAt: number = now(),
  ): void {
    this.records.push({ actionType, startedAt, finishedAt });
  }

  async measure<T>(
    actionType: AutomationEventSourceTimingActionType,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    const result = await operation();
    this.recordElapsed(actionType, startedAt);
    return result;
  }

  createRunTiming(): AutomationEventRunTiming {
    return new AutomationEventRunTiming(
      this.source,
      this.apiStartTime,
      this.records,
    );
  }

  fork(): AutomationEventSourceTiming {
    return new AutomationEventSourceTiming(
      this.source,
      this.apiStartTime,
      this.records,
    );
  }
}

export function createAutomationEventSourceTiming(
  source: AutomationEventSource,
  args: {
    readonly apiStartTime: number;
    readonly backgroundScheduledAt?: number;
  },
): AutomationEventSourceTiming {
  const timing = new AutomationEventSourceTiming(source, args.apiStartTime);
  if (args.backgroundScheduledAt !== undefined) {
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_automation_event_background_start_gap",
      args.backgroundScheduledAt,
    );
  }
  return timing;
}

export class AutomationEventRunTiming {
  private readonly collector = new ApiDispatchTimingCollector();
  private finalized = false;

  constructor(
    private readonly source: AutomationEventSource,
    private readonly apiStartTime: number,
    records: readonly AutomationEventSourceTimingRecord[],
  ) {
    for (const record of records) {
      this.recordElapsed(
        record.actionType,
        record.startedAt,
        record.finishedAt,
      );
    }
  }

  recordElapsed(
    actionType: AutomationEventSourceTimingActionType,
    startedAt: number,
    finishedAt: number = now(),
  ): void {
    this.collector.recordElapsed(
      actionType,
      "nested",
      startedAt,
      finishedAt,
      automationEventSourceDimensions(this.source),
    );
  }

  async measure<T>(
    actionType: AutomationEventSourceTimingActionType,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return await measureApiDispatchTiming(
      this.collector,
      actionType,
      "nested",
      operation,
      automationEventSourceDimensions(this.source),
    );
  }

  collectorForRunStart(): ApiDispatchTimingCollector {
    if (!this.finalized) {
      const finishedAt = now();
      this.recordElapsed(
        "api_dispatch_pre_create_agent_automation_event_handoff_run",
        finishedAt,
        finishedAt,
      );
      this.collector.recordElapsed(
        "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
        "nested",
        this.apiStartTime,
        finishedAt,
        automationEventSourceDimensions(this.source),
      );
      this.finalized = true;
    }
    return this.collector;
  }
}

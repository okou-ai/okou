import { logger } from "../../lib/log";
import {
  googleCalendarEventSnapshots,
  googleCalendarProcessedEvents,
  googleCalendarWatchStates,
} from "@okouai/db/schema/google-calendar-event";
import {
  workflowAutomations,
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  AutomationEventSourceTiming,
  type AutomationEventRunTiming,
} from "./automation-event-source-timing.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { GoogleCalendarSourceTransitionChangedError } from "./workflow-google-calendar-queue.service";
import { GOOGLE_CALENDAR_EVENT_TYPES } from "./google-calendar-automation-account.service";
import { workflowAutomationCanFire$ } from "./workflow-automation-access.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";
import {
  WATCH_RENEWAL_WINDOW_MS,
  type EnsureGoogleCalendarWatchResult,
  calendarEventAttendeeSchema,
  type GoogleCalendarEvent,
  type GoogleCalendarWatchStateRow,
  resolveGoogleCalendarAccess$,
  type CalendarEventsListOk,
  listCalendarEvents,
  parseGoogleDate,
  eventSnapshotValue,
  upsertCalendarEventSnapshots$,
  calendarWatchActionRequiredEpisode,
  googleCalendarWatchTargetType,
  hasEnabledGoogleCalendarConsumer$,
  ensureGoogleCalendarWatchForUser$,
  reconcileGoogleCalendarWatchState$,
  repairAndEnsureGoogleCalendarWatchesForOwner$,
  repairGoogleCalendarAutomationProjections$,
  parseGoogleCalendarEventAutomationConfig,
} from "./google-calendar-automation-watch.service";

const log = logger("api:google-calendar-automation-event");

const ATTENDEE_PROMPT_LIMIT = 20;

type GoogleCalendarEventSnapshotRow =
  typeof googleCalendarEventSnapshots.$inferSelect;

type GoogleCalendarChangeType = "created" | "updated" | "cancelled";

interface GoogleCalendarEventAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
}

interface GoogleCalendarWebhookNotification {
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
  readonly resourceState: string;
  readonly messageNumber: string | null;
}

interface CalendarEventContext {
  readonly changeType: GoogleCalendarChangeType;
  readonly calendarId: string;
  readonly eventId: string;
  readonly summary: string | null;
  readonly status: string | null;
  readonly eventType: string | null;
  readonly htmlLink: string | null;
  readonly start: GoogleCalendarEvent["start"] | null;
  readonly end: GoogleCalendarEvent["end"] | null;
  readonly organizer: GoogleCalendarEvent["organizer"] | null;
  readonly attendees: readonly z.infer<typeof calendarEventAttendeeSchema>[];
  readonly created: string | null;
  readonly updated: string | null;
  readonly recurringEventId: string | null;
  readonly originalStartTime: GoogleCalendarEvent["originalStartTime"] | null;
  readonly previousSnapshot: Record<string, unknown> | null;
  readonly changedFields: readonly string[];
}

interface CalendarEventChange {
  readonly changeType: GoogleCalendarChangeType;
  readonly event: GoogleCalendarEvent;
  readonly eventChangeKey: string;
  readonly previousSnapshot: Record<string, unknown> | null;
  readonly changedFields: readonly string[];
}

type GoogleCalendarDispatchStateResult =
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | {
      readonly kind: "run_error";
      readonly message: string;
    };

type GoogleCalendarWebhookResult =
  | {
      readonly kind: "ok";
      readonly watchStates: number;
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | {
      readonly kind: "unauthorized";
    }
  | {
      readonly kind: "bad_request";
      readonly message: string;
    }
  | {
      readonly kind: "run_error";
      readonly message: string;
    };

function eventPromptContext(
  calendarId: string,
  change: CalendarEventChange,
): CalendarEventContext {
  const { event } = change;
  return {
    changeType: change.changeType,
    calendarId,
    eventId: event.id,
    summary: event.summary ?? null,
    status: event.status ?? null,
    eventType: event.eventType ?? null,
    htmlLink: event.htmlLink ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    organizer: event.organizer ?? null,
    attendees: event.attendees ?? [],
    created: event.created ?? null,
    updated: event.updated ?? null,
    recurringEventId: event.recurringEventId ?? null,
    originalStartTime: event.originalStartTime ?? null,
    previousSnapshot: change.previousSnapshot,
    changedFields: change.changedFields,
  };
}

function eventSnapshotHash(event: GoogleCalendarEvent): string {
  return createHash("sha256")
    .update(JSON.stringify(eventSnapshotValue(event)))
    .digest("hex");
}

function eventChangeKey(
  changeType: GoogleCalendarChangeType,
  event: GoogleCalendarEvent,
): string {
  if (changeType === "created") {
    return "created";
  }
  if (changeType === "cancelled") {
    if (event.etag) {
      return `cancelled:etag:${event.etag}`;
    }
    if (event.updated) {
      return `cancelled:updated:${event.updated}`;
    }
    return `cancelled:${event.id}`;
  }
  if (event.etag) {
    return `etag:${event.etag}`;
  }
  if (event.updated) {
    return `updated:${event.updated}`;
  }
  return `snapshot:${eventSnapshotHash(event)}`;
}

function eventSnapshotChanged(
  previousSnapshot: Record<string, unknown> | null,
  currentSnapshot: Record<string, unknown>,
): boolean {
  if (!previousSnapshot) {
    return true;
  }
  return JSON.stringify(previousSnapshot) !== JSON.stringify(currentSnapshot);
}

function eventRevisionChanged(args: {
  readonly previous: GoogleCalendarEventSnapshotRow;
  readonly event: GoogleCalendarEvent;
  readonly currentSnapshot: Record<string, unknown>;
}): boolean {
  if (args.previous.etag && args.event.etag) {
    return args.previous.etag !== args.event.etag;
  }

  const eventUpdatedAt = parseGoogleDate(args.event.updated);
  if (args.previous.eventUpdatedAt && eventUpdatedAt) {
    return args.previous.eventUpdatedAt.getTime() !== eventUpdatedAt.getTime();
  }

  return eventSnapshotChanged(
    args.previous.snapshot ?? null,
    args.currentSnapshot,
  );
}

function changedCalendarEventFields(
  previousSnapshot: Record<string, unknown> | null,
  currentSnapshot: Record<string, unknown>,
): string[] {
  if (!previousSnapshot) {
    return [];
  }

  const fields = new Set([
    ...Object.keys(previousSnapshot),
    ...Object.keys(currentSnapshot),
  ]);
  return Array.from(fields)
    .filter((field) => {
      return (
        JSON.stringify(previousSnapshot[field]) !==
        JSON.stringify(currentSnapshot[field])
      );
    })
    .sort();
}

function calendarEventChangeForSnapshot(args: {
  readonly event: GoogleCalendarEvent;
  readonly previous: GoogleCalendarEventSnapshotRow | undefined;
}): CalendarEventChange | null {
  const currentSnapshot = eventSnapshotValue(args.event);
  if (args.event.status === "cancelled") {
    if (
      args.previous?.status === "cancelled" &&
      !eventRevisionChanged({
        previous: args.previous,
        event: args.event,
        currentSnapshot,
      })
    ) {
      return null;
    }
    return {
      changeType: "cancelled",
      event: args.event,
      eventChangeKey: eventChangeKey("cancelled", args.event),
      previousSnapshot: args.previous?.snapshot ?? null,
      changedFields: changedCalendarEventFields(
        args.previous?.snapshot ?? null,
        currentSnapshot,
      ),
    };
  }

  if (!args.previous) {
    return {
      changeType: "created",
      event: args.event,
      eventChangeKey: eventChangeKey("created", args.event),
      previousSnapshot: null,
      changedFields: [],
    };
  }

  if (
    !eventRevisionChanged({
      previous: args.previous,
      event: args.event,
      currentSnapshot,
    })
  ) {
    return null;
  }

  return {
    changeType: "updated",
    event: args.event,
    eventChangeKey: eventChangeKey("updated", args.event),
    previousSnapshot: args.previous.snapshot ?? null,
    changedFields: changedCalendarEventFields(
      args.previous.snapshot ?? null,
      currentSnapshot,
    ),
  };
}

const baselineCalendarWatchState$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly accessToken: string;
    },
    signal: AbortSignal,
  ): Promise<EnsureGoogleCalendarWatchResult> => {
    const db = set(writeDb$);
    const baseline = await listCalendarEvents(
      {
        accessToken: args.accessToken,
        calendarId: args.state.calendarId,
        syncToken: null,
      },
      signal,
    );
    signal.throwIfAborted();
    if (baseline.kind !== "ok") {
      return {
        kind: "bad_request",
        message:
          baseline.kind === "stale_cursor"
            ? "Failed to establish Google Calendar event automation baseline"
            : baseline.message,
      };
    }
    const currentTime = nowDate();
    await set(
      upsertCalendarEventSnapshots$,
      {
        watchStateId: args.state.id,
        events: baseline.events,
        currentTime,
      },
      signal,
    );
    await db
      .update(googleCalendarWatchStates)
      .set({
        syncToken: baseline.nextSyncToken,
        needsRewatch: false,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(googleCalendarWatchStates.id, args.state.id),
          isNull(googleCalendarWatchStates.actionRequiredReason),
          isNull(googleCalendarWatchStates.actionRequiredAt),
        ),
      );
    signal.throwIfAborted();
    return { kind: "ok" };
  },
);

const loadMissingGoogleCalendarWatchTargets$ = command(
  async ({
    set,
  }): Promise<
    readonly {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly calendarId: string;
    }[]
  > => {
    const db = set(writeDb$);
    const consumers = await db
      .select({
        orgId: workflowAutomations.orgId,
        userId: workflowAutomations.ownerUserId,
        connectorId: workflowAutomations.eventConnectorId,
        eventType: workflowAutomations.eventType,
        eventConfig: workflowAutomations.eventConfig,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          isNotNull(workflowAutomations.eventConnectorId),
          inArray(workflowAutomations.eventType, [
            ...GOOGLE_CALENDAR_EVENT_TYPES,
          ]),
        ),
      );
    const states = await db
      .select({
        connectorId: googleCalendarWatchStates.connectorId,
        calendarId: googleCalendarWatchStates.calendarId,
      })
      .from(googleCalendarWatchStates);
    const existingKeys = new Set(
      states.map((state) => {
        return `${state.connectorId}\n${state.calendarId}`;
      }),
    );
    const missing = new Map<
      string,
      {
        readonly orgId: string;
        readonly userId: string;
        readonly connectorId: string;
        readonly calendarId: string;
      }
    >();
    for (const consumer of consumers) {
      if (consumer.connectorId === null) {
        continue;
      }
      const config = parseGoogleCalendarEventAutomationConfig({
        eventType: consumer.eventType,
        eventConfig: consumer.eventConfig,
      });
      if (!config) {
        continue;
      }
      const watchKey = `${consumer.connectorId}\n${config.calendarId}`;
      if (existingKeys.has(watchKey)) {
        continue;
      }
      missing.set(watchKey, {
        orgId: consumer.orgId,
        userId: consumer.userId,
        connectorId: consumer.connectorId,
        calendarId: config.calendarId,
      });
    }
    return [...missing.values()];
  },
);

function decodeCalendarWebhookHeaders(headers: Headers):
  | GoogleCalendarWebhookNotification
  | {
      readonly kind: "bad_request";
    } {
  const channelId = headers.get("x-goog-channel-id");
  const channelToken = headers.get("x-goog-channel-token");
  const resourceId = headers.get("x-goog-resource-id");
  const resourceState = headers.get("x-goog-resource-state");
  if (!channelId || !channelToken || !resourceId || !resourceState) {
    return { kind: "bad_request" };
  }
  return {
    channelId,
    channelToken,
    resourceId,
    resourceState,
    messageNumber: headers.get("x-goog-message-number"),
  };
}

const loadCalendarWatchStateForNotification$ = command(
  async (
    { set },
    args: {
      readonly notification: GoogleCalendarWebhookNotification;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchStateRow | null> => {
    const db = set(writeDb$);
    const [state] = await db
      .select()
      .from(googleCalendarWatchStates)
      .where(
        and(
          eq(googleCalendarWatchStates.channelId, args.notification.channelId),
          eq(
            googleCalendarWatchStates.channelToken,
            args.notification.channelToken,
          ),
          eq(
            googleCalendarWatchStates.resourceId,
            args.notification.resourceId,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return state ?? null;
  },
);

const loadCalendarEventSnapshotMap$ = command(
  async (
    { set },
    args: {
      readonly watchStateId: string;
      readonly events: readonly GoogleCalendarEvent[];
    },
    signal: AbortSignal,
  ): Promise<Map<string, GoogleCalendarEventSnapshotRow>> => {
    const db = set(writeDb$);
    const ids = args.events.map((event) => {
      return event.id;
    });
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await db
      .select()
      .from(googleCalendarEventSnapshots)
      .where(
        and(
          eq(googleCalendarEventSnapshots.watchStateId, args.watchStateId),
          inArray(googleCalendarEventSnapshots.calendarEventId, ids),
        ),
      );
    signal.throwIfAborted();
    return new Map(
      rows.map((row) => {
        return [row.calendarEventId, row];
      }),
    );
  },
);

const loadGoogleCalendarEventAutomations$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarEventAutomationRow[]> => {
    const db = set(writeDb$);
    const automationRows = await db
      .select({
        automation: workflowAutomationColumns(),
        agentId: workflows.agentId,
        workflowName: workflows.name,
        workflowDisplayName: workflows.displayName,
        chatThreadId: workflowUserAutomationThreads.chatThreadId,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
      .leftJoin(
        workflowUserAutomationThreads,
        and(
          eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
          eq(
            workflowUserAutomationThreads.userId,
            workflowAutomations.ownerUserId,
          ),
          eq(
            workflowUserAutomationThreads.workflowId,
            workflowAutomations.workflowId,
          ),
        ),
      )
      .where(
        and(
          eq(workflowAutomations.orgId, args.state.orgId),
          eq(workflowAutomations.ownerUserId, args.state.userId),
          eq(workflowAutomations.eventConnectorId, args.state.connectorId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          inArray(workflowAutomations.eventType, [
            "google-calendar-event-created",
            "google-calendar-event-updated",
            "google-calendar-event-cancelled",
          ]),
        ),
      );
    signal.throwIfAborted();
    const currentTime = nowDate();
    const automations: GoogleCalendarEventAutomationRow[] = [];
    for (const row of automationRows) {
      const config = parseGoogleCalendarEventAutomationConfig(row.automation);
      if (!config || config.calendarId !== args.state.calendarId) {
        continue;
      }
      const canFire = await set(
        workflowAutomationCanFire$,
        {
          automation: row.automation,
          agentId: row.agentId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!canFire) {
        continue;
      }
      const chatThreadId =
        row.chatThreadId ??
        (await set(
          ensureWorkflowUserAutomationThread$,
          {
            orgId: row.automation.orgId,
            userId: row.automation.ownerUserId,
            workflowId: row.automation.workflowId,
            agentId: row.agentId,
            workflowTitle: row.workflowDisplayName ?? row.workflowName,
            currentTime,
          },
          signal,
        ));
      signal.throwIfAborted();
      automations.push({
        automation: row.automation,
        agentId: row.agentId,
        workflowName: row.workflowName,
        chatThreadId,
      });
    }
    return automations;
  },
);

function googleCalendarTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly event: CalendarEventContext;
  readonly eventChangeKey: string;
}): WorkflowAutomationContext {
  const changed =
    args.event.changeType === "created"
      ? "was created"
      : args.event.changeType === "updated"
        ? "was updated"
        : "was cancelled";
  return {
    workflowName: args.workflowName,
    eventType:
      args.event.changeType === "created"
        ? "google-calendar-event-created"
        : args.event.changeType === "updated"
          ? "google-calendar-event-updated"
          : "google-calendar-event-cancelled",
    trigger: `Google Calendar event ${args.event.eventId} on calendar ${args.event.calendarId} ${changed} (change ${args.eventChangeKey}).`,
    notes: [
      "Connected Google Calendar tools return further calendar event detail.",
    ],
    event: {
      automationId: args.automationId,
      eventChangeKey: args.eventChangeKey,
      changeType: args.event.changeType,
      calendarId: args.event.calendarId,
      eventId: args.event.eventId,
      summary: args.event.summary,
      status: args.event.status,
      eventType: args.event.eventType,
      htmlLink: args.event.htmlLink,
      start: args.event.start,
      end: args.event.end,
      organizer: args.event.organizer,
      attendees: args.event.attendees.slice(0, ATTENDEE_PROMPT_LIMIT),
      attendeeCount: args.event.attendees.length,
      created: args.event.created,
      updated: args.event.updated,
      recurringEventId: args.event.recurringEventId,
      originalStartTime: args.event.originalStartTime,
      changedFields: args.event.changedFields,
      previousSnapshot: args.event.previousSnapshot,
    },
  };
}

const startGoogleCalendarAutomationRun$ = command(
  async (
    { set },
    args: {
      readonly automation: GoogleCalendarEventAutomationRow;
      readonly state: GoogleCalendarWatchStateRow;
      readonly event: CalendarEventContext;
      readonly eventChangeKey: string;
      readonly timing: AutomationEventRunTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<"ok" | "error" | "superseded"> => {
    const runInput = await args.timing.measure(
      "api_dispatch_pre_create_agent_automation_event_build_run_input",
      () => {
        const context = googleCalendarTriggerContext({
          workflowName: args.automation.workflowName,
          automationId: args.automation.automation.id,
          event: args.event,
          eventChangeKey: args.eventChangeKey,
        });
        return { context };
      },
    );
    signal.throwIfAborted();
    const started = await settle(
      set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation: args.automation.automation,
            agentId: args.automation.agentId,
            chatThreadId: args.automation.chatThreadId,
          },
          automationContext: runInput.context,
          connectorSourceId: args.state.connectorId,
          apiStartTime: args.apiStartTime,
          triggerSource: "automation-event",
          sourcePlan: {
            kind: "google-calendar",
            source: {
              automationId: args.automation.automation.id,
              orgId: args.automation.automation.orgId,
              userId: args.automation.automation.ownerUserId,
              connectorId: args.state.connectorId,
              watchStateId: args.state.id,
              channelId: args.state.channelId,
              calendarId: args.state.calendarId,
            },
          },
          timing: args.timing.collectorForRunStart(),
        },
        signal,
      ),
      signal,
    );
    if (!started.ok) {
      if (started.error instanceof GoogleCalendarSourceTransitionChangedError) {
        return "superseded";
      }
      throw started.error;
    }
    return "ok";
  },
);

const insertGoogleCalendarProcessedEvent$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly automation: GoogleCalendarEventAutomationRow;
      readonly notification: GoogleCalendarWebhookNotification;
      readonly event: CalendarEventContext;
      readonly eventChangeKey: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const [processed] = await db
      .insert(googleCalendarProcessedEvents)
      .values({
        watchStateId: args.state.id,
        automationId: args.automation.automation.id,
        channelId: args.state.channelId,
        resourceState: args.notification.resourceState,
        calendarEventId: args.event.eventId,
        eventChangeKey: args.eventChangeKey,
        eventCreatedAt: parseGoogleDate(args.event.created ?? undefined),
        eventUpdatedAt: parseGoogleDate(args.event.updated ?? undefined),
        createdAt: nowDate(),
      })
      .onConflictDoNothing()
      .returning({ id: googleCalendarProcessedEvents.id });
    signal.throwIfAborted();
    return processed?.id ?? null;
  },
);

const dispatchGoogleCalendarAutomationEvent$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly automation: GoogleCalendarEventAutomationRow;
      readonly notification: GoogleCalendarWebhookNotification;
      readonly event: CalendarEventContext;
      readonly eventChangeKey: string;
      readonly timing: AutomationEventRunTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<
    | "dispatched"
    | "duplicate"
    | "superseded"
    | {
        readonly kind: "run_error";
      }
  > => {
    const db = set(writeDb$);
    const processedId = await args.timing.measure(
      "api_dispatch_pre_create_agent_automation_event_record_processed_event",
      async () => {
        return await set(insertGoogleCalendarProcessedEvent$, args, signal);
      },
    );
    signal.throwIfAborted();
    if (!processedId) {
      return "duplicate";
    }
    const result = await set(
      startGoogleCalendarAutomationRun$,
      {
        automation: args.automation,
        state: args.state,
        event: args.event,
        eventChangeKey: args.eventChangeKey,
        timing: args.timing,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result === "superseded") {
      await db
        .delete(googleCalendarProcessedEvents)
        .where(eq(googleCalendarProcessedEvents.id, processedId));
      signal.throwIfAborted();
      return "superseded";
    }
    if (result !== "ok") {
      await db
        .delete(googleCalendarProcessedEvents)
        .where(eq(googleCalendarProcessedEvents.id, processedId));
      signal.throwIfAborted();
      return { kind: "run_error" };
    }
    return "dispatched";
  },
);

function googleCalendarAutomationMatchesChange(
  automation: GoogleCalendarEventAutomationRow,
  changeType: GoogleCalendarChangeType,
): boolean {
  if (changeType === "created") {
    return automation.automation.eventType === "google-calendar-event-created";
  }
  if (changeType === "updated") {
    return automation.automation.eventType === "google-calendar-event-updated";
  }
  return automation.automation.eventType === "google-calendar-event-cancelled";
}

const dispatchCalendarEventChanges$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly notification: GoogleCalendarWebhookNotification;
      readonly changes: readonly CalendarEventChange[];
      readonly automations: readonly GoogleCalendarEventAutomationRow[];
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarDispatchStateResult> => {
    if (args.automations.length === 0 || args.changes.length === 0) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }
    let dispatched = 0;
    let duplicates = 0;
    for (const change of args.changes) {
      const changeTiming = args.sourceTiming.fork();
      const context = eventPromptContext(args.state.calendarId, change);
      for (const automation of args.automations) {
        const runTiming = changeTiming.createRunTiming();
        const matches = await runTiming.measure(
          "api_dispatch_pre_create_agent_automation_event_match_automations",
          () => {
            return googleCalendarAutomationMatchesChange(
              automation,
              change.changeType,
            );
          },
        );
        signal.throwIfAborted();
        if (!matches) {
          continue;
        }
        const result = await set(
          dispatchGoogleCalendarAutomationEvent$,
          {
            state: args.state,
            automation,
            notification: args.notification,
            event: context,
            eventChangeKey: change.eventChangeKey,
            timing: runTiming,
            apiStartTime: args.apiStartTime,
          },
          signal,
        );
        if (typeof result !== "string") {
          return {
            kind: "run_error",
            message: "Failed to start Google Calendar event workflow run",
          };
        }
        dispatched += result === "dispatched" ? 1 : 0;
        duplicates += result === "duplicate" ? 1 : 0;
      }
    }
    return { kind: "ok", dispatched, duplicates };
  },
);

const dispatchGoogleCalendarChanges$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly notification: GoogleCalendarWebhookNotification;
      readonly changes: CalendarEventsListOk;
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarDispatchStateResult> => {
    const db = set(writeDb$);
    const snapshotMap = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_external_events",
      async () => {
        return await set(
          loadCalendarEventSnapshotMap$,
          {
            watchStateId: args.state.id,
            events: args.changes.events,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    const calendarEventChanges = args.changes.events
      .map((event) => {
        return calendarEventChangeForSnapshot({
          event,
          previous: snapshotMap.get(event.id),
        });
      })
      .filter((change): change is CalendarEventChange => {
        return change !== null;
      });
    const automations = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_automations",
      async () => {
        return await set(
          loadGoogleCalendarEventAutomations$,
          {
            state: args.state,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    const result = await set(
      dispatchCalendarEventChanges$,
      {
        state: args.state,
        notification: args.notification,
        changes: calendarEventChanges,
        automations,
        sourceTiming: args.sourceTiming,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
    if (result.kind !== "ok") {
      return result;
    }
    const currentTime = nowDate();
    await set(
      upsertCalendarEventSnapshots$,
      {
        watchStateId: args.state.id,
        events: args.changes.events,
        currentTime,
      },
      signal,
    );
    await db
      .update(googleCalendarWatchStates)
      .set({
        syncToken: args.changes.nextSyncToken,
        needsRewatch: false,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(googleCalendarWatchStates.id, args.state.id),
          isNull(googleCalendarWatchStates.actionRequiredReason),
          isNull(googleCalendarWatchStates.actionRequiredAt),
        ),
      );
    signal.throwIfAborted();
    return result;
  },
);

const prepareCalendarNotificationChanges$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly accessToken: string;
    },
    signal: AbortSignal,
  ): Promise<CalendarEventsListOk | null> => {
    const changes =
      args.state.syncToken === null
        ? { kind: "stale_cursor" as const }
        : await listCalendarEvents(
            {
              accessToken: args.accessToken,
              calendarId: args.state.calendarId,
              syncToken: args.state.syncToken,
            },
            signal,
          );
    signal.throwIfAborted();
    if (changes.kind === "stale_cursor") {
      const baseline = await set(baselineCalendarWatchState$, args, signal);
      signal.throwIfAborted();
      if (baseline.kind !== "ok") {
        log.warn("Google Calendar baseline sync failed", {
          watchStateId: args.state.id,
          message: baseline.message,
        });
      }
      return null;
    }
    if (changes.kind === "calendar_error") {
      log.warn("Google Calendar event sync failed", {
        watchStateId: args.state.id,
        message: changes.message,
      });
      return null;
    }
    return changes;
  },
);

const dispatchGoogleCalendarWatchState$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly notification: GoogleCalendarWebhookNotification;
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarDispatchStateResult> => {
    const db = set(writeDb$);
    const actionRequiredEpisode = calendarWatchActionRequiredEpisode(
      args.state,
    );
    if (actionRequiredEpisode) {
      log.debug("Workflow watch dispatch skipped", {
        provider: "google_calendar",
        action: "dispatch",
        result: "action_required",
        reason: actionRequiredEpisode.reason,
        watchStateId: args.state.id,
        episodeStartedAt: actionRequiredEpisode.startedAt.toISOString(),
        targetType: googleCalendarWatchTargetType(args.state.calendarId),
      });
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }
    const hasConsumer = await set(
      hasCurrentGoogleCalendarWatchConsumer$,
      args,
      signal,
    );
    if (!hasConsumer) {
      log.debug("Workflow watch dispatch skipped", {
        provider: "google_calendar",
        action: "dispatch",
        result: "no_consumer",
      });
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }
    const access = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_source_state",
      async () => {
        return await set(
          resolveGoogleCalendarAccess$,
          {
            orgId: args.state.orgId,
            userId: args.state.userId,
            connectorId: args.state.connectorId,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (access.kind !== "ok") {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }
    const baselineInput = {
      state: args.state,
      accessToken: access.access.accessToken,
    };
    if (args.notification.resourceState === "not_exists") {
      await db
        .update(googleCalendarWatchStates)
        .set({ needsRewatch: true, updatedAt: nowDate() })
        .where(eq(googleCalendarWatchStates.id, args.state.id));
      signal.throwIfAborted();
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }
    const changes = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_external_events",
      async () => {
        return await set(
          prepareCalendarNotificationChanges$,
          baselineInput,
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (changes === null) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }
    return await set(
      dispatchGoogleCalendarChanges$,
      {
        state: args.state,
        notification: args.notification,
        changes,
        sourceTiming: args.sourceTiming,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
  },
);

const hasCurrentGoogleCalendarWatchConsumer$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly sourceTiming: AutomationEventSourceTiming;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const hasConsumer = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_automations",
      async () => {
        return await set(
          hasEnabledGoogleCalendarConsumer$,
          {
            orgId: args.state.orgId,
            userId: args.state.userId,
            connectorId: args.state.connectorId,
            calendarId: args.state.calendarId,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (hasConsumer) {
      return true;
    }
    await set(repairGoogleCalendarAutomationProjections$, {
      orgId: args.state.orgId,
      userId: args.state.userId,
    });
    signal.throwIfAborted();
    return await set(
      hasEnabledGoogleCalendarConsumer$,
      {
        orgId: args.state.orgId,
        userId: args.state.userId,
        connectorId: args.state.connectorId,
        calendarId: args.state.calendarId,
      },
      signal,
    );
  },
);

export const dispatchGoogleCalendarWebhook$ = command(
  async (
    { set },
    args: {
      readonly headers: Headers;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWebhookResult> => {
    const notification = decodeCalendarWebhookHeaders(args.headers);
    if ("kind" in notification) {
      return {
        kind: "bad_request",
        message: "Missing Google Calendar webhook headers",
      };
    }

    const sourceTiming = new AutomationEventSourceTiming(
      "google_calendar",
      args.apiStartTime,
    );
    const state = await sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_source_state",
      async () => {
        return await set(
          loadCalendarWatchStateForNotification$,
          {
            notification,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (!state) {
      return { kind: "unauthorized" };
    }
    const result = await set(
      dispatchGoogleCalendarWatchState$,
      {
        state,
        notification,
        sourceTiming,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
    if (result.kind !== "ok") {
      return result;
    }

    return {
      kind: "ok",
      watchStates: 1,
      dispatched: result.dispatched,
      duplicates: result.duplicates,
    };
  },
);

const renewGoogleCalendarWatchStates$ = command(
  async (
    { set },
    args: {
      readonly states: readonly {
        readonly connectorId: string;
        readonly calendarId: string;
      }[];
      readonly renewBefore: Date;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly renewed: number;
    readonly failed: number;
  }> => {
    let renewed = 0;
    let failed = 0;
    for (const state of args.states) {
      const result = await set(
        reconcileGoogleCalendarWatchState$,
        {
          connectorId: state.connectorId,
          calendarId: state.calendarId,
          renewBefore: args.renewBefore,
        },
        signal,
      );
      signal.throwIfAborted();
      renewed += result.kind === "renewed" ? 1 : 0;
      failed += result.kind === "failed" ? 1 : 0;
    }
    return { renewed, failed };
  },
);

export const renewGoogleCalendarWatches$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const renewBefore = new Date(
      currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS,
    );
    const automationOwners = await db
      .selectDistinct({
        orgId: workflowAutomations.orgId,
        userId: workflowAutomations.ownerUserId,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          isNull(workflowAutomations.eventConnectorId),
          inArray(workflowAutomations.eventType, [
            ...GOOGLE_CALENDAR_EVENT_TYPES,
          ]),
        ),
      );
    signal.throwIfAborted();

    let failed = 0;
    for (const owner of automationOwners) {
      const prepared = await set(
        repairAndEnsureGoogleCalendarWatchesForOwner$,
        { ...owner, ensureRefreshRequired: false },
        signal,
      );
      signal.throwIfAborted();
      if (!prepared) {
        failed += 1;
        log.warn("Google Calendar watch repair failed", {
          provider: "google_calendar",
          action: "repair",
          result: "provider_error",
        });
      }
    }
    const missingTargets = await set(loadMissingGoogleCalendarWatchTargets$);
    signal.throwIfAborted();
    for (const target of missingTargets) {
      const ensured = await set(
        ensureGoogleCalendarWatchForUser$,
        { ...target },
        signal,
      );
      signal.throwIfAborted();
      if (ensured.kind !== "ok") {
        failed += 1;
        log.warn("Google Calendar watch repair failed", {
          provider: "google_calendar",
          action: "ensure_missing",
          result: "provider_error",
        });
      }
    }

    const states = await db
      .select({
        connectorId: googleCalendarWatchStates.connectorId,
        calendarId: googleCalendarWatchStates.calendarId,
      })
      .from(googleCalendarWatchStates);
    signal.throwIfAborted();
    const renewedStates = await set(
      renewGoogleCalendarWatchStates$,
      { states, renewBefore },
      signal,
    );
    return {
      renewed: renewedStates.renewed,
      failed: failed + renewedStates.failed,
    };
  },
);

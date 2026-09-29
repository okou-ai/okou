import { command } from "ccstate";
import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleFormsResponseSubmittedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, isNotNull } from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import {
  ensureGmailWatchForUser,
  reconcileGmailWatchesForUser,
} from "./gmail-automation-event.service";
import {
  ensureGoogleCalendarWatchForUser,
  reconcileGoogleCalendarWatchesForUser,
  stageGoogleCalendarWatchTargetForReconfiguration,
} from "./google-calendar-automation-event.service";
import {
  ensureGoogleFormsWatchForUser$,
  reconcileGoogleFormsWatchesForUser$,
} from "./google-forms-automation-event.service";
import {
  ensureGoogleMeetTranscriptGeneratedSubscriptionForUser,
  reconcileGoogleMeetSubscriptionsForUser,
} from "./google-meet-automation-event.service";

interface AutomationEventWatchAutomation {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly eventType: string | null;
  readonly eventConfig: unknown;
  readonly eventConnectorId: string | null;
}

type AutomationEventWatchTarget =
  | {
      readonly provider: "gmail";
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string | null;
    }
  | {
      readonly provider: "google_calendar";
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string | null;
      readonly calendarId: string;
    }
  | {
      readonly provider: "google_forms";
      readonly orgId: string;
      readonly userId: string;
      readonly formId: string;
      readonly connectorId: string;
    }
  | {
      readonly provider: "google_meet";
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    };

function googleCalendarId(
  automation: AutomationEventWatchAutomation,
): string | null {
  if (automation.eventType === "google-calendar-event-created") {
    const config = googleCalendarEventCreatedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? config.data.calendarId : null;
  }
  if (automation.eventType === "google-calendar-event-updated") {
    const config = googleCalendarEventUpdatedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? config.data.calendarId : null;
  }
  if (automation.eventType === "google-calendar-event-cancelled") {
    const config = googleCalendarEventCancelledEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? config.data.calendarId : null;
  }
  return null;
}

function automationEventWatchTarget(
  automation: AutomationEventWatchAutomation,
): AutomationEventWatchTarget | null {
  if (
    automation.eventType === "gmail-new-message" ||
    automation.eventType === "gmail-label-applied"
  ) {
    return {
      provider: "gmail",
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      connectorId: automation.eventConnectorId ?? null,
    };
  }
  if (automation.eventType === "google-forms-response-submitted") {
    const config = googleFormsResponseSubmittedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    if (
      !config.success ||
      automation.eventConnectorId === null ||
      config.data.connectorId !== automation.eventConnectorId
    ) {
      return null;
    }
    return {
      provider: "google_forms",
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      formId: config.data.form.id,
      connectorId: automation.eventConnectorId,
    };
  }
  if (automation.eventType === "google-meet-transcript-generated") {
    if (automation.eventConnectorId === null) {
      return null;
    }
    return {
      provider: "google_meet",
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      connectorId: automation.eventConnectorId,
    };
  }
  const calendarId = googleCalendarId(automation);
  if (calendarId === null) {
    return null;
  }
  return {
    provider: "google_calendar",
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    connectorId: automation.eventConnectorId ?? null,
    calendarId,
  };
}

function targetKey(target: AutomationEventWatchTarget): string {
  if (target.provider === "gmail") {
    return `gmail:${target.orgId}:${target.userId}:${target.connectorId ?? "unavailable"}`;
  }
  if (target.provider === "google_forms") {
    return `google_forms:${target.orgId}:${target.userId}`;
  }
  if (target.provider === "google_meet") {
    return `google_meet:${target.orgId}:${target.userId}:${target.connectorId}`;
  }
  return `google_calendar:${target.orgId}:${target.userId}:${target.connectorId ?? "unavailable"}:${target.calendarId}`;
}
export const reconcileAutomationEventWatches$ = command(
  async (
    { set },
    args: {
      readonly automations: readonly AutomationEventWatchAutomation[];
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const targets = new Map<string, AutomationEventWatchTarget>();
    for (const automation of args.automations) {
      const target = automationEventWatchTarget(automation);
      if (target) {
        targets.set(targetKey(target), target);
      }
    }
    let succeeded = true;
    for (const target of targets.values()) {
      if (target.provider === "gmail") {
        const reconciled = await reconcileGmailWatchesForUser(
          {
            db: db,
            orgId: target.orgId,
            userId: target.userId,
          },
          signal,
        );
        succeeded &&= reconciled;
        continue;
      }
      if (target.provider === "google_forms") {
        const reconciled = await set(
          reconcileGoogleFormsWatchesForUser$,
          {
            orgId: target.orgId,
            userId: target.userId,
          },
          signal,
        );
        succeeded &&= reconciled;
        continue;
      }
      if (target.provider === "google_meet") {
        const reconciled = await reconcileGoogleMeetSubscriptionsForUser(
          {
            db: db,
            orgId: target.orgId,
            userId: target.userId,
          },
          signal,
        );
        succeeded &&= reconciled;
        continue;
      }
      const reconciled = await reconcileGoogleCalendarWatchesForUser(
        {
          db: db,
          orgId: target.orgId,
          userId: target.userId,
          ...(target.connectorId === null
            ? {}
            : { connectorId: target.connectorId }),
          calendarId: target.calendarId,
        },
        signal,
      );
      succeeded &&= reconciled;
    }
    return succeeded;
  },
);
/**
 * Reconciles every durable provider watch owned by one Workflow member.
 * Provider reconcilers retain targets that still have an enabled Automation
 * consumer, so this also removes a prepared target whose structural transition
 * crashed before the target was promoted into the Automation row.
 */
export const reconcileAutomationEventWatchInventoryForOwner$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const gmail = await reconcileGmailWatchesForUser(
      { db, orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();
    const calendar = await reconcileGoogleCalendarWatchesForUser(
      { db, orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();
    const meet = await reconcileGoogleMeetSubscriptionsForUser(
      { db, orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();
    const forms = await set(
      reconcileGoogleFormsWatchesForUser$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();
    return gmail && calendar && forms && meet;
  },
);

interface CurrentAutomationEventWatchAutomation extends AutomationEventWatchAutomation {
  readonly id: string;
  readonly enabled: boolean;
}

interface GoogleFormsEventWatchPreparation {
  readonly automationId: string;
  readonly seedCursor: string;
}
type AutomationEventWatchReconfigurationResult =
  | {
      readonly kind: "ok";
    }
  | {
      readonly kind: "bad-request";
      readonly message: string;
    };
async function ensureNonFormsTarget(
  db: Db,
  target: Exclude<
    AutomationEventWatchTarget,
    {
      provider: "google_forms";
    }
  >,
  allowStagedOfficialTarget: boolean,
  signal: AbortSignal,
): Promise<AutomationEventWatchReconfigurationResult> {
  let result:
    | {
        readonly kind: "ok";
      }
    | {
        readonly kind: "bad_request";
        readonly message: string;
      };
  if (target.provider === "gmail") {
    result =
      target.connectorId === null
        ? {
            kind: "bad_request",
            message: "Connect Gmail before using Gmail event automations",
          }
        : await ensureGmailWatchForUser(
            {
              db,
              orgId: target.orgId,
              userId: target.userId,
              connectorId: target.connectorId,
              forceRefresh: false,
              allowStagedOfficialTarget,
            },
            signal,
          );
  } else if (target.provider === "google_meet") {
    result = await ensureGoogleMeetTranscriptGeneratedSubscriptionForUser(
      {
        db,
        orgId: target.orgId,
        userId: target.userId,
        connectorId: target.connectorId,
        allowStagedOfficialTarget,
      },
      signal,
    );
  } else {
    result =
      target.connectorId === null
        ? {
            kind: "bad_request",
            message:
              "Connect Google Calendar before using Google Calendar event automations",
          }
        : allowStagedOfficialTarget
          ? await stageGoogleCalendarWatchTargetForReconfiguration(
              {
                db,
                orgId: target.orgId,
                userId: target.userId,
                connectorId: target.connectorId,
                calendarId: target.calendarId,
                forceRefresh: false,
              },
              signal,
            )
          : await ensureGoogleCalendarWatchForUser(
              {
                db,
                orgId: target.orgId,
                userId: target.userId,
                connectorId: target.connectorId,
                calendarId: target.calendarId,
                forceRefresh: false,
              },
              signal,
            );
  }
  signal.throwIfAborted();
  return result.kind === "ok"
    ? result
    : { kind: "bad-request", message: result.message };
}
const ensureGoogleFormsTarget$ = command(
  async (
    { set },
    args: {
      readonly automation: CurrentAutomationEventWatchAutomation;
      readonly target: Extract<
        AutomationEventWatchTarget,
        {
          provider: "google_forms";
        }
      >;
      readonly seedCursor: string | undefined;
      readonly allowStagedOfficialTarget: boolean;
    },
    signal: AbortSignal,
  ): Promise<AutomationEventWatchReconfigurationResult> => {
    const result = await set(
      ensureGoogleFormsWatchForUser$,
      {
        orgId: args.target.orgId,
        userId: args.target.userId,
        formId: args.target.formId,
        connectorId: args.target.connectorId,
        allowStagedOfficialTarget: args.allowStagedOfficialTarget,
        ...(args.seedCursor === undefined
          ? {}
          : {
              resetAutomationId: args.automation.id,
              seedCursor: args.seedCursor,
            }),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok"
      ? { kind: "ok" }
      : { kind: "bad-request", message: result.message };
  },
);
export const reconcileAutomationEventWatchReconfiguration$ = command(
  async (
    { set },
    args: {
      readonly previous: readonly AutomationEventWatchAutomation[];
      readonly current: readonly CurrentAutomationEventWatchAutomation[];
      readonly googleForms: readonly GoogleFormsEventWatchPreparation[];
    },
    signal: AbortSignal,
  ): Promise<AutomationEventWatchReconfigurationResult> => {
    const ensured = await set(
      ensureAutomationEventWatchReconfiguration$,
      { current: args.current, googleForms: args.googleForms },
      signal,
    );
    if (ensured.kind !== "ok") {
      return ensured;
    }
    const reconciled = await set(
      reconcileAutomationEventWatches$,
      { automations: [...args.previous, ...args.current] },
      signal,
    );
    return reconciled
      ? { kind: "ok" }
      : {
          kind: "bad-request",
          message: "Failed to reconcile Automation event-watch lifecycle",
        };
  },
);
/**
 * Establishes the event-watch side of a pending Automation configuration.
 * The caller may keep the durable Automation disabled until a later locked
 * promotion, so this deliberately does not prune targets without a current
 * database consumer.
 */
export const ensureAutomationEventWatchReconfiguration$ = command(
  async (
    { set },
    args: {
      readonly current: readonly CurrentAutomationEventWatchAutomation[];
      readonly googleForms: readonly GoogleFormsEventWatchPreparation[];
      readonly allowStagedOfficialTargets?: boolean;
    },
    signal: AbortSignal,
  ): Promise<AutomationEventWatchReconfigurationResult> => {
    const db = set(writeDb$);
    const allowStagedOfficialTargets = args.allowStagedOfficialTargets === true;
    if (allowStagedOfficialTargets) {
      for (const automation of args.current) {
        if (!automation.enabled || !automationEventWatchTarget(automation)) {
          continue;
        }
        const [staged] = await db
          .select({ id: workflowAutomations.id })
          .from(workflowAutomations)
          .where(
            and(
              eq(workflowAutomations.id, automation.id),
              eq(workflowAutomations.orgId, automation.orgId),
              eq(workflowAutomations.ownerUserId, automation.ownerUserId),
              eq(workflowAutomations.enabled, false),
              eq(
                workflowAutomations.officialReconciliationStatus,
                "reconciling",
              ),
              isNotNull(workflowAutomations.officialBlueprintKey),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!staged) {
          return {
            kind: "bad-request",
            message: "Official Automation watch target is no longer staged",
          };
        }
      }
    }
    const seedByAutomationId = new Map(
      args.googleForms.map((entry) => {
        return [entry.automationId, entry.seedCursor] as const;
      }),
    );
    const nonFormsTargets = new Map<
      string,
      Exclude<
        AutomationEventWatchTarget,
        {
          provider: "google_forms";
        }
      >
    >();
    for (const automation of args.current) {
      if (!automation.enabled) {
        continue;
      }
      const target = automationEventWatchTarget(automation);
      if (!target) {
        continue;
      }
      if (target.provider === "google_forms") {
        const ensured = await set(
          ensureGoogleFormsTarget$,
          {
            automation,
            target,
            seedCursor: seedByAutomationId.get(automation.id),
            allowStagedOfficialTarget: allowStagedOfficialTargets,
          },
          signal,
        );
        if (ensured.kind !== "ok") {
          return ensured;
        }
        continue;
      }
      nonFormsTargets.set(targetKey(target), target);
    }
    for (const target of nonFormsTargets.values()) {
      const ensured = await ensureNonFormsTarget(
        db,
        target,
        allowStagedOfficialTargets,
        signal,
      );
      if (ensured.kind !== "ok") {
        return ensured;
      }
    }
    return { kind: "ok" };
  },
);

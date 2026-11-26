import { command } from "ccstate";
import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleFormsResponseSubmittedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { reconcileGmailWatchesForUser$ } from "./gmail-automation-watch.service";
import { reconcileGoogleCalendarWatchesForUser$ } from "./google-calendar-automation-watch.service";
import { reconcileGoogleFormsWatchesForUser$ } from "./google-forms-automation-watch.service";
import { reconcileGoogleMeetSubscriptionsForUser$ } from "./google-meet-automation-watch.service";

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
        const reconciled = await set(
          reconcileGmailWatchesForUser$,
          {
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
        const reconciled = await set(
          reconcileGoogleMeetSubscriptionsForUser$,
          {
            orgId: target.orgId,
            userId: target.userId,
          },
          signal,
        );
        succeeded &&= reconciled;
        continue;
      }
      const reconciled = await set(
        reconcileGoogleCalendarWatchesForUser$,
        {
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

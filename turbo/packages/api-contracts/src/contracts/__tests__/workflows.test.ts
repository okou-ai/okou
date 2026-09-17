import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  workflowSummarySchema,
  workflowOwnerProfileSchema,
  githubPullRequestEventConfigSchema,
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleFormsResponseSubmittedEventConfigSchema,
  googleFormsResponseSubmittedEventCreateConfigSchema,
  googleMeetTranscriptGeneratedEventConfigSchema,
  gmailLabelAppliedEventConfigSchema,
  gmailNewMessageEventConfigSchema,
  chatThreadWorkflowAutomationSchema,
  stripeInvoicePaidEventConfigSchema,
  workflowAutomationSummarySchema,
  workflowUpdateRequestSchema,
  workflowAutomationCreateRequestSchema,
  workflowAutomationUpdateRequestSchema,
} from "../workflows";

describe("Gmail new message workflow automation contract", () => {
  it("accepts only explicit text match fields", () => {
    const parsed = gmailNewMessageEventConfigSchema.safeParse({
      provider: "gmail",
      event: "new_message",
      threadId: "gmail-thread-1",
      match: {
        from: { contains: "@example.com" },
        to: { containsAny: ["team@example.com"] },
        cc: { doesNotContain: "archive@example.com" },
        subject: { doesNotContainAny: ["newsletter"] },
        body: { contains: "invoice" },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects removed match fields", () => {
    const removedMatchRules = [
      { snippet: { contains: "preview" } },
      { labels: { includeAny: ["INBOX"] } },
      { hasAttachment: true },
    ];

    for (const match of removedMatchRules) {
      const parsed = gmailNewMessageEventConfigSchema.safeParse({
        provider: "gmail",
        event: "new_message",
        match,
      });

      expect(parsed.success).toBe(false);
    }
  });
});

describe("Gmail label applied workflow automation contract", () => {
  it("accepts a label name and optional resolved label id", () => {
    const parsed = gmailLabelAppliedEventConfigSchema.safeParse({
      provider: "gmail",
      event: "label_applied",
      labelName: "Support",
      resolvedLabelId: "Label_123",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts label applied automation create requests", () => {
    const parsed = workflowAutomationCreateRequestSchema.safeParse({
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: "Support",
      },
    });

    expect(parsed.success).toBe(true);
  });
});

describe("GitHub pull request workflow automation contract", () => {
  it("accepts a merged filter on the closed action", () => {
    const parsed = githubPullRequestEventConfigSchema.safeParse({
      provider: "github",
      event: "pull_request",
      repository: "vm0-ai/vm0",
      action: "closed",
      merged: true,
      filters: {
        baseBranches: ["main"],
        pullRequestNumbers: ["42"],
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a merged filter on non-closed actions", () => {
    const parsed = githubPullRequestEventConfigSchema.safeParse({
      provider: "github",
      event: "pull_request",
      repository: "vm0-ai/vm0",
      action: "opened",
      merged: true,
      filters: {},
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts pull request automation create requests", () => {
    const parsed = workflowAutomationCreateRequestSchema.safeParse({
      kind: "event",
      eventType: "github-pull-request",
      eventConfig: {
        provider: "github",
        event: "pull_request",
        repository: "vm0-ai/vm0",
        action: "labeled",
        filters: { labels: ["ready-to-merge"] },
      },
    });

    expect(parsed.success).toBe(true);
  });
});

describe("Google Calendar event-created workflow automation contract", () => {
  it("defaults to the primary calendar", () => {
    const parsed = googleCalendarEventCreatedEventConfigSchema.parse({
      provider: "google-calendar",
      event: "event_created",
    });

    expect(parsed).toStrictEqual({
      provider: "google-calendar",
      event: "event_created",
      calendarId: "primary",
    });
  });

  it("accepts event-created automation create requests without explicit config", () => {
    const parsed = workflowAutomationCreateRequestSchema.parse({
      kind: "event",
      eventType: "google-calendar-event-created",
    });

    expect(parsed).toStrictEqual({
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      },
    });
  });

  it("accepts only typed action-required warnings in summaries", () => {
    const summary = {
      id: "11111111-1111-4111-8111-111111111111",
      ownerUserId: "user_calendar",
      enabled: true,
      chatThreadId: null,
      nextRunAt: null,
      lastRunAt: null,
      official: null,
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      },
      schedule: null,
      scheduleSummary: null,
      warning: "reconnect_required",
    } as const;

    expect(workflowAutomationSummarySchema.parse(summary)).toStrictEqual(
      summary,
    );
    expect(
      workflowAutomationSummarySchema.safeParse({
        ...summary,
        warning: "provider_error",
      }).success,
    ).toBeFalsy();
  });
});

describe("Google Calendar event-updated workflow automation contract", () => {
  it("defaults to the primary calendar", () => {
    const parsed = googleCalendarEventUpdatedEventConfigSchema.parse({
      provider: "google-calendar",
      event: "event_updated",
    });

    expect(parsed).toStrictEqual({
      provider: "google-calendar",
      event: "event_updated",
      calendarId: "primary",
    });
  });

  it("accepts event-updated automation create requests without explicit config", () => {
    const parsed = workflowAutomationCreateRequestSchema.parse({
      kind: "event",
      eventType: "google-calendar-event-updated",
    });

    expect(parsed).toStrictEqual({
      kind: "event",
      eventType: "google-calendar-event-updated",
      eventConfig: {
        provider: "google-calendar",
        event: "event_updated",
        calendarId: "primary",
      },
    });
  });
});

describe("Google Calendar event-cancelled workflow automation contract", () => {
  it("defaults to the primary calendar", () => {
    const parsed = googleCalendarEventCancelledEventConfigSchema.parse({
      provider: "google-calendar",
      event: "event_cancelled",
    });

    expect(parsed).toStrictEqual({
      provider: "google-calendar",
      event: "event_cancelled",
      calendarId: "primary",
    });
  });

  it("accepts event-cancelled automation create requests without explicit config", () => {
    const parsed = workflowAutomationCreateRequestSchema.parse({
      kind: "event",
      eventType: "google-calendar-event-cancelled",
    });

    expect(parsed).toStrictEqual({
      kind: "event",
      eventType: "google-calendar-event-cancelled",
      eventConfig: {
        provider: "google-calendar",
        event: "event_cancelled",
        calendarId: "primary",
      },
    });
  });
});

describe("Google Forms response-submitted workflow automation contract", () => {
  it("keeps create and persisted configs separate", () => {
    expect(
      googleFormsResponseSubmittedEventCreateConfigSchema.parse({
        provider: "google-forms",
        event: "response_submitted",
        formUrl: "https://docs.google.com/forms/d/1FAIpQLScContractsTest/edit",
      }),
    ).toStrictEqual({
      provider: "google-forms",
      event: "response_submitted",
      formUrl: "https://docs.google.com/forms/d/1FAIpQLScContractsTest/edit",
    });

    const persisted = {
      provider: "google-forms",
      event: "response_submitted",
      connectorId: "55555555-5555-4555-8555-555555555557",
      form: {
        id: "1FAIpQLScContractsTest",
        title: "Customer survey",
        url: "https://docs.google.com/forms/d/1FAIpQLScContractsTest/edit",
      },
    };
    expect(
      googleFormsResponseSubmittedEventConfigSchema.parse(persisted),
    ).toStrictEqual(persisted);
    expect(
      googleFormsResponseSubmittedEventConfigSchema.safeParse({
        ...persisted,
        formUrl: persisted.form.url,
      }).success,
    ).toBe(false);
  });

  it("accepts a response-submitted create request", () => {
    expect(
      workflowAutomationCreateRequestSchema.safeParse({
        kind: "event",
        eventType: "google-forms-response-submitted",
        eventConfig: {
          provider: "google-forms",
          event: "response_submitted",
          formUrl: "1FAIpQLScContractsTest",
        },
      }).success,
    ).toBe(true);
  });
});

describe("Google Calendar workflow automation update contract", () => {
  it("accepts each Calendar event configuration", () => {
    const events = [
      "event_created",
      "event_updated",
      "event_cancelled",
    ] as const;

    for (const event of events) {
      expect(
        workflowAutomationUpdateRequestSchema.parse({
          eventConfig: {
            provider: "google-calendar",
            event,
            calendarId: "team-calendar@example.com",
          },
        }),
      ).toStrictEqual({
        eventConfig: {
          provider: "google-calendar",
          event,
          calendarId: "team-calendar@example.com",
        },
      });
    }
  });
});

describe("Google Meet transcript-generated workflow automation contract", () => {
  it("defaults to organizer-user scope", () => {
    const parsed = googleMeetTranscriptGeneratedEventConfigSchema.parse({
      provider: "google-meet",
      event: "transcript_generated",
    });

    expect(parsed).toStrictEqual({
      provider: "google-meet",
      event: "transcript_generated",
      scope: { type: "organizer_user" },
    });
  });

  it("accepts transcript-generated automation create requests without explicit config", () => {
    const parsed = workflowAutomationCreateRequestSchema.parse({
      kind: "event",
      eventType: "google-meet-transcript-generated",
    });

    expect(parsed).toStrictEqual({
      kind: "event",
      eventType: "google-meet-transcript-generated",
      eventConfig: {
        provider: "google-meet",
        event: "transcript_generated",
        scope: { type: "organizer_user" },
      },
    });
  });
});

describe("Stripe invoice-paid workflow automation contract", () => {
  const billingReasons = [
    "automatic_pending_invoice_item_invoice",
    "manual",
    "quote_accept",
    "subscription",
    "subscription_create",
    "subscription_cycle",
    "subscription_threshold",
    "subscription_update",
    "upcoming",
  ] as const;

  it.each([undefined, [], billingReasons])(
    "accepts supported billing reason filters %#",
    (filter) => {
      expect(
        workflowAutomationCreateRequestSchema.safeParse({
          kind: "event",
          eventType: "stripe-invoice-paid",
          eventConfig: {
            provider: "stripe",
            event: "invoice_paid",
            ...(filter === undefined ? {} : { billingReasons: filter }),
          },
        }).success,
      ).toBe(true);
    },
  );

  it("rejects unknown billing reasons and client-owned binding fields", () => {
    expect(
      workflowAutomationCreateRequestSchema.safeParse({
        kind: "event",
        eventType: "stripe-invoice-paid",
        eventConfig: {
          provider: "stripe",
          event: "invoice_paid",
          billingReasons: ["future_reason"],
        },
      }).success,
    ).toBe(false);

    for (const binding of [
      { connectorId: "11111111-1111-4111-8111-111111111111" },
      { stripeAccountId: "acct_client" },
      { mode: "live" },
    ]) {
      expect(
        workflowAutomationCreateRequestSchema.safeParse({
          kind: "event",
          eventType: "stripe-invoice-paid",
          eventConfig: {
            provider: "stripe",
            event: "invoice_paid",
            ...binding,
          },
        }).success,
      ).toBe(false);
    }
  });

  it("parses the server-owned binding in persisted summaries", () => {
    const eventConfig = stripeInvoicePaidEventConfigSchema.parse({
      provider: "stripe",
      event: "invoice_paid",
      billingReasons: ["subscription_cycle"],
      connectorId: "11111111-1111-4111-8111-111111111111",
      stripeAccountId: "acct_live",
      mode: "live",
    });
    const summary = {
      id: "22222222-2222-4222-8222-222222222222",
      ownerUserId: "user_stripe",
      enabled: true,
      chatThreadId: null,
      nextRunAt: null,
      lastRunAt: null,
      official: null,
      kind: "event",
      eventType: "stripe-invoice-paid",
      eventConfig,
      schedule: null,
      scheduleSummary: null,
      health: {
        lastMatchingEventReceivedAt: null,
        lastDeliveryStatus: null,
        lastDeliveryStatusAt: null,
        warning: null,
      },
    } as const;

    expect(workflowAutomationSummarySchema.parse(summary)).toStrictEqual(
      summary,
    );
    expect(
      chatThreadWorkflowAutomationSchema.parse({
        ...summary,
        chatThreadId: "33333333-3333-4333-8333-333333333333",
        workflow: {
          id: "44444444-4444-4444-8444-444444444444",
          agentId: "55555555-5555-4555-8555-555555555555",
          name: "stripe-invoice-paid",
          displayName: "Stripe invoice paid",
          description: null,
        },
      }),
    ).toMatchObject({ eventConfig });
  });

  it("keeps Stripe event configuration out of the update contract", () => {
    expect(
      workflowAutomationUpdateRequestSchema.safeParse({
        eventConfig: {
          provider: "stripe",
          event: "invoice_paid",
          billingReasons: ["manual"],
        },
      }).success,
    ).toBe(false);
  });
});

describe("workflow update contract", () => {
  it("accepts slug metadata updates", () => {
    const parsed = workflowUpdateRequestSchema.safeParse({
      name: "follow-up",
      displayName: "Follow up",
      description: "Use when a prospect needs a next step.",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects invalid workflow slugs", () => {
    const parsed = workflowUpdateRequestSchema.safeParse({
      name: "Follow Up",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("workflow display-profile rollout compatibility", () => {
  const workflow = {
    id: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    agentName: "agent",
    agentDisplayName: null,
    name: "workflow",
    displayName: null,
    description: null,
    visibility: "private",
    ownerUserId: "user-owner",
    createdAt: "2026-09-14T00:00:00.000Z",
    canManage: true,
    canPublish: true,
    official: null,
  };

  it("allows an old app's optional nullable fields to be omitted by a new API", () => {
    const oldSummary = workflowSummarySchema.extend({
      ownerUserDisplayName: z.string().nullable().optional(),
      ownerUserImageUrl: z.string().nullable().optional(),
    });
    expect(oldSummary.parse(workflow).ownerUserId).toBe("user-owner");
  });

  it("allows a new app to read an older API's enriched response", () => {
    expect(
      workflowSummarySchema.parse({
        ...workflow,
        ownerUserDisplayName: "Older API",
        ownerUserImageUrl: null,
      }),
    ).toEqual(workflow);
    expect(
      workflowOwnerProfileSchema.parse({ displayName: null, imageUrl: null }),
    ).toEqual({ displayName: null, imageUrl: null });
  });
});

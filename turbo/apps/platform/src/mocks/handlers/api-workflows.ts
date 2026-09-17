import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowAutomationsContract,
  workflowVisibilityContract,
  type ChatThreadWorkflowAutomation,
  type WorkflowDetailResponse,
  type WorkflowSummary,
  type WorkflowAutomationsListEntry,
  type WorkflowAutomationCreateRequest,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";

import { mockApi } from "../msw-contract.ts";
import {
  getMockWorkflowAutomations,
  setMockWorkflowAutomations,
} from "./workflow-automations-store.ts";

const DEFAULT_WORKFLOWS: WorkflowDetailResponse[] = [];

let mockWorkflows: WorkflowDetailResponse[] = [...DEFAULT_WORKFLOWS];

function notFound(workflowId: string) {
  return {
    error: { message: `Workflow not found: ${workflowId}`, code: "NOT_FOUND" },
  };
}

function summary(workflow: WorkflowDetailResponse): WorkflowSummary {
  return {
    id: workflow.id,
    agentId: workflow.agentId,
    agentName: workflow.agentName,
    agentDisplayName: workflow.agentDisplayName,
    name: workflow.name,
    displayName: workflow.displayName,
    description: workflow.description,
    visibility: workflow.visibility,
    ownerUserId: workflow.ownerUserId,
    createdAt: workflow.createdAt,
    canManage: workflow.canManage,
    canPublish: workflow.canPublish,
    official: workflow.official,
  };
}

function automationSummaryBase(automation: ChatThreadWorkflowAutomation) {
  return {
    id: automation.id,
    ownerUserId: automation.ownerUserId,
    enabled: automation.enabled,
    chatThreadId: automation.chatThreadId,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    official: null,
  };
}

function automationSummary(
  automation: ChatThreadWorkflowAutomation,
): WorkflowAutomationSummary {
  if (automation.kind === "event") {
    return {
      ...automationSummaryBase(automation),
      kind: "event",
      eventType: automation.eventType,
      eventConfig: automation.eventConfig,
      schedule: null,
      scheduleSummary: null,
    } as WorkflowAutomationSummary;
  }
  return {
    ...automationSummaryBase(automation),
    kind: "schedule",
    schedule: automation.schedule,
    scheduleSummary: automation.scheduleSummary,
  };
}

function publicWorkflowAutomation(
  automation: WorkflowAutomationSummary,
): WorkflowAutomationSummary {
  if (
    automation.kind !== "event" ||
    automation.eventType !== "webhook-received"
  ) {
    return automation;
  }
  const {
    webhookUrl: _webhookUrl,
    webhookSecret: _webhookSecret,
    ...rest
  } = automation;
  return rest;
}

export function resetMockWorkflows(): void {
  mockWorkflows = [...DEFAULT_WORKFLOWS];
}

export const apiWorkflowsHandlers = [
  mockApi(workflowsCollectionContract.list, ({ query, respond }) => {
    const agentId = query.agentId;
    const visible = agentId
      ? mockWorkflows.filter((workflow) => {
          return workflow.agentId === agentId;
        })
      : mockWorkflows;
    return respond(200, visible.map(summary));
  }),

  mockApi(workflowsCollectionContract.create, ({ body, respond }) => {
    const now = new Date().toISOString();
    const created: WorkflowDetailResponse = {
      id: crypto.randomUUID(),
      agentId: body.agentId,
      agentName: null,
      agentDisplayName: null,
      name: body.name,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      visibility: body.visibility ?? "private",
      ownerUserId: "test-user-123",
      canManage: true,
      canPublish: true,
      official: null,
      createdByUserId: "test-user-123",
      updatedByUserId: "test-user-123",
      createdAt: now,
      updatedAt: now,
      instruction: body.instruction ?? null,
      files: (body.files ?? []).map((file) => {
        return {
          path: file.path,
          size: new TextEncoder().encode(file.content).length,
        };
      }),
      fileContents: body.files ?? [],
      automations: [],
    };
    mockWorkflows = [...mockWorkflows, created];
    return respond(201, summary(created));
  }),

  mockApi(workflowsDetailContract.ownerProfile, ({ params, respond }) => {
    if (!mockWorkflows.some((workflow) => workflow.id === params.workflowId)) {
      return respond(404, notFound(params.workflowId));
    }
    return respond(200, { displayName: "Test User", imageUrl: null });
  }),
  mockApi(workflowsDetailContract.get, ({ params, respond }) => {
    const workflow = mockWorkflows.find((item) => {
      return item.id === params.workflowId;
    });
    if (!workflow) {
      return respond(404, notFound(params.workflowId));
    }
    return respond(200, workflow);
  }),

  mockApi(workflowsDetailContract.update, ({ body, params, respond }) => {
    const index = mockWorkflows.findIndex((item) => {
      return item.id === params.workflowId;
    });
    if (index === -1) {
      return respond(404, notFound(params.workflowId));
    }

    const existing = mockWorkflows[index]!;
    const now = new Date().toISOString();
    const files = body.files ?? existing.fileContents ?? [];
    const updated: WorkflowDetailResponse = {
      ...existing,
      updatedByUserId: "test-user-123",
      updatedAt: now,
      name: body.name === undefined ? existing.name : body.name,
      instruction:
        body.instruction === undefined
          ? existing.instruction
          : body.instruction,
      displayName:
        body.displayName === undefined
          ? existing.displayName
          : body.displayName,
      description:
        body.description === undefined
          ? existing.description
          : body.description,
      files: files.map((file) => {
        return {
          path: file.path,
          size: new TextEncoder().encode(file.content).length,
        };
      }),
      fileContents: files,
    };
    mockWorkflows[index] = updated;
    return respond(200, updated);
  }),

  mockApi(workflowsDetailContract.delete, ({ params, respond }) => {
    const index = mockWorkflows.findIndex((item) => {
      return item.id === params.workflowId;
    });
    if (index === -1) {
      return respond(404, notFound(params.workflowId));
    }
    mockWorkflows = mockWorkflows.filter((item) => {
      return item.id !== params.workflowId;
    });
    return respond(204);
  }),

  mockApi(workflowsDetailContract.copy, ({ body, params, respond }) => {
    const source = mockWorkflows.find((item) => {
      return item.id === params.workflowId;
    });
    if (!source) {
      return respond(404, notFound(params.workflowId));
    }
    const now = new Date().toISOString();
    const copied: WorkflowDetailResponse = {
      ...source,
      id: crypto.randomUUID(),
      agentId: body.toAgentId,
      visibility: "private",
      ownerUserId: "test-user-123",
      canPublish: true,
      createdByUserId: "test-user-123",
      updatedByUserId: "test-user-123",
      createdAt: now,
      updatedAt: now,
      automations: source.automations.map((automation) => {
        return {
          ...automation,
          id: crypto.randomUUID(),
          ownerUserId: "test-user-123",
          lastRunAt: null,
        };
      }),
    };
    mockWorkflows = [...mockWorkflows, copied];
    return respond(201, summary(copied));
  }),

  mockApi(workflowsDetailContract.run, ({ params, respond }) => {
    const workflow = mockWorkflows.find((item) => {
      return item.id === params.workflowId;
    });
    if (!workflow) {
      return respond(404, notFound(params.workflowId));
    }
    return respond(200, {
      chatThreadId: "00000000-0000-4000-a000-000000000fff",
      runId: `run-${workflow.id}`,
    });
  }),

  mockApi(workflowsDetailContract.chatThread, ({ params, respond }) => {
    const workflow = mockWorkflows.find((item) => {
      return item.id === params.workflowId;
    });
    if (!workflow) {
      return respond(404, notFound(params.workflowId));
    }
    return respond(200, {
      chatThreadId: "00000000-0000-4000-a000-000000000fff",
      prompt: `help me refine the workflow /${workflow.name}`,
    });
  }),

  ...visibilityHandlers(),
  ...workflowAutomationHandlers(),
];

function visibilityHandlers() {
  const transition = (
    workflowId: string,
    apply: (workflow: WorkflowDetailResponse) => WorkflowDetailResponse,
  ): WorkflowSummary | null => {
    const index = mockWorkflows.findIndex((item) => {
      return item.id === workflowId;
    });
    if (index === -1) {
      return null;
    }
    const updated = apply(mockWorkflows[index]!);
    const now = new Date().toISOString();
    mockWorkflows[index] = {
      ...updated,
      updatedByUserId: "test-user-123",
      updatedAt: now,
    };
    return summary(mockWorkflows[index]!);
  };

  return [
    mockApi(workflowVisibilityContract.publish, ({ params, respond }) => {
      const result = transition(params.workflowId, (workflow) => {
        return { ...workflow, visibility: "public" };
      });
      return result
        ? respond(200, result)
        : respond(404, notFound(params.workflowId));
    }),
    mockApi(workflowVisibilityContract.demote, ({ params, respond }) => {
      const result = transition(params.workflowId, (workflow) => {
        return { ...workflow, visibility: "private" };
      });
      return result
        ? respond(200, result)
        : respond(404, notFound(params.workflowId));
    }),
  ];
}

function updateDetailAutomation(
  automationId: string,
  apply: (automation: WorkflowAutomationSummary) => WorkflowAutomationSummary,
): WorkflowAutomationSummary | null {
  for (const workflow of mockWorkflows) {
    const automationIndex = workflow.automations.findIndex((automation) => {
      return automation.id === automationId;
    });
    if (automationIndex === -1) {
      continue;
    }
    const updated = apply(workflow.automations[automationIndex]!);
    workflow.automations = workflow.automations.map((automation) => {
      return automation.id === automationId ? updated : automation;
    });
    return updated;
  }
  return null;
}

function updateChatThreadAutomation(
  automationId: string,
  apply: (
    automation: ChatThreadWorkflowAutomation,
  ) => ChatThreadWorkflowAutomation,
): WorkflowAutomationSummary | null {
  const automations = getMockWorkflowAutomations();
  const automation = automations.find((item) => {
    return item.id === automationId;
  });
  if (!automation) {
    return null;
  }
  const updated = apply(automation);
  setMockWorkflowAutomations(
    automations.map((item) => {
      return item.id === automationId ? updated : item;
    }),
  );
  return automationSummary(updated);
}

function notFoundAutomation() {
  return {
    error: {
      message: "Workflow automation not found",
      code: "NOT_FOUND",
    },
  };
}

function mockWorkflowAutomationExists(automationId: string): boolean {
  return (
    getMockWorkflowAutomations().some((automation) => {
      return automation.id === automationId;
    }) ||
    mockWorkflows.some((workflow) => {
      return workflow.automations.some((automation) => {
        return automation.id === automationId;
      });
    })
  );
}

function mockScheduleSummary(
  schedule: Extract<
    WorkflowAutomationSummary,
    { kind: "schedule" }
  >["schedule"],
): string {
  if (schedule.type === "cron") {
    return `${schedule.cronExpression} (${schedule.timezone})`;
  }
  if (schedule.type === "once") {
    return `Once at ${schedule.atTime}`;
  }
  return `Every ${schedule.intervalSeconds}s`;
}

function workflowAutomationListHandlers() {
  return [
    mockApi(workflowAutomationsContract.listWorkspace, ({ respond }) => {
      const entries: WorkflowAutomationsListEntry[] = mockWorkflows.flatMap(
        (workflow) => {
          return workflow.automations.map((automation) => {
            return {
              workflow: summary(workflow),
              automation: publicWorkflowAutomation(automation),
            };
          });
        },
      );
      // The ts-rest mock responder retains the legacy spread source's
      // response type even though the canonical contract overrides status 200.
      return respond(200, entries as never);
    }),

    mockApi(workflowAutomationsContract.list, ({ params, respond }) => {
      const workflow = mockWorkflows.find((item) => {
        return item.id === params.workflowId;
      });
      if (!workflow) {
        return respond(404, notFound(params.workflowId));
      }
      return respond(200, workflow.automations.map(publicWorkflowAutomation));
    }),

    mockApi(
      workflowAutomationsContract.listForChatThread,
      ({ params, respond }) => {
        return respond(
          200,
          getMockWorkflowAutomations().filter((automation) => {
            return automation.chatThreadId === params.threadId;
          }),
        );
      },
    ),
  ];
}

type WorkflowAutomationCreateBase = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly enabled: boolean;
  readonly chatThreadId: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly official: null;
};

function createNotionChildPageAutomationSummary(
  base: WorkflowAutomationCreateBase,
  parentPageUrl: string,
): WorkflowAutomationSummary {
  return {
    ...base,
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      connectorId: "b0000000-0000-4000-a000-000000000001",
      parentPage: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Roadmap",
        url: parentPageUrl,
        rawUrl: parentPageUrl,
      },
    },
    schedule: null,
    scheduleSummary: null,
  };
}

function createNotionDatabaseItemAutomationSummary(
  base: WorkflowAutomationCreateBase,
  databaseUrl: string,
): WorkflowAutomationSummary {
  return {
    ...base,
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      connectorId: "b0000000-0000-4000-a000-000000000001",
      dataSource: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Bug Bash",
        url: databaseUrl,
        rawUrl: databaseUrl,
      },
    },
    schedule: null,
    scheduleSummary: null,
  };
}

function createNotionPageContentUpdatedAutomationSummary(
  base: WorkflowAutomationCreateBase,
  args: { readonly pageUrl?: string; readonly databaseUrl?: string },
): WorkflowAutomationSummary {
  return {
    ...base,
    kind: "event",
    eventType: "notion-page-content-updated",
    eventConfig: {
      provider: "notion",
      event: "page_content_updated",
      connectorId: "b0000000-0000-4000-a000-000000000001",
      scope: args.pageUrl
        ? {
            type: "page",
            page: {
              id: "33333333-3333-4333-8333-333333333333",
              title: "Release plan",
              url: args.pageUrl,
              rawUrl: args.pageUrl,
            },
          }
        : {
            type: "data_source",
            dataSource: {
              id: "22222222-2222-4222-8222-222222222222",
              title: "Bug Bash",
              url: args.databaseUrl ?? "https://www.notion.so/database",
              rawUrl: args.databaseUrl,
            },
          },
    },
    schedule: null,
    scheduleSummary: null,
  };
}

/**
 * Config-passthrough event kinds whose mock summary is just the request
 * config echoed back. The caller narrows `body` by eliminating every other
 * kind first, so no runtime dispatch is needed here.
 */
function passthroughEventAutomationSummaryForRequest(
  base: WorkflowAutomationCreateBase,
  body: Extract<
    WorkflowAutomationCreateRequest,
    {
      readonly eventType:
        | "google-calendar-event-created"
        | "google-calendar-event-updated"
        | "google-calendar-event-cancelled"
        | "google-meet-transcript-generated"
        | "chat-run-finished";
    }
  >,
): WorkflowAutomationSummary {
  return {
    ...base,
    kind: "event",
    eventType: body.eventType,
    eventConfig: body.eventConfig,
    schedule: null,
    scheduleSummary: null,
  } as WorkflowAutomationSummary;
}

function createStripeInvoicePaidAutomationSummary(
  base: WorkflowAutomationCreateBase,
  body: Extract<
    WorkflowAutomationCreateRequest,
    { readonly eventType: "stripe-invoice-paid" }
  >,
): WorkflowAutomationSummary {
  return {
    ...base,
    kind: "event",
    eventType: "stripe-invoice-paid",
    eventConfig: {
      ...body.eventConfig,
      connectorId: "b0000000-0000-4000-a000-000000000002",
      stripeAccountId: "acct_mock_stripe_invoice_paid",
      mode: "live",
    },
    schedule: null,
    scheduleSummary: null,
    health: {
      lastMatchingEventReceivedAt: null,
      lastDeliveryStatus: null,
      lastDeliveryStatusAt: null,
      warning: null,
    },
  };
}

function createWorkflowAutomationSummaryForRequest(
  base: WorkflowAutomationCreateBase,
  body: WorkflowAutomationCreateRequest,
): WorkflowAutomationSummary {
  if ("schedule" in body) {
    return {
      ...base,
      kind: "schedule",
      schedule: body.schedule,
      scheduleSummary: mockScheduleSummary(body.schedule),
    };
  }
  if (body.eventType === "webhook-received") {
    return {
      ...base,
      kind: "event",
      eventType: "webhook-received",
      eventConfig: body.eventConfig ?? {
        provider: "webhook",
        event: "received",
        auth: { mode: "hmac-sha256" },
      },
      schedule: null,
      scheduleSummary: null,
      webhookUrl:
        "http://localhost:3000/api/webhooks/workflow-automations/mock",
      secretLastFour: "mock",
      lastReceivedAt: null,
      webhookSecret: "mock-webhook-secret",
    };
  }
  if (body.eventType === "gmail-new-message") {
    return {
      ...base,
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (body.eventType === "gmail-label-applied") {
    return {
      ...base,
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (
    body.eventType === "github-pull-request" ||
    body.eventType === "github-workflow-run-completed" ||
    body.eventType === "github-workflow-job-completed" ||
    body.eventType === "github-pull-request-review-submitted" ||
    body.eventType === "github-deployment-status-created" ||
    body.eventType === "github-issue-comment-created"
  ) {
    return {
      ...base,
      kind: "event",
      eventType: body.eventType,
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    } as WorkflowAutomationSummary;
  }
  if (body.eventType === "notion-child-page-created") {
    return createNotionChildPageAutomationSummary(
      base,
      body.eventConfig.parentPageUrl,
    );
  }
  if (body.eventType === "notion-database-item-created") {
    return createNotionDatabaseItemAutomationSummary(
      base,
      body.eventConfig.databaseUrl,
    );
  }
  if (body.eventType === "notion-page-content-updated") {
    return createNotionPageContentUpdatedAutomationSummary(base, {
      pageUrl: body.eventConfig.pageUrl,
      databaseUrl: body.eventConfig.databaseUrl,
    });
  }
  if (body.eventType === "google-forms-response-submitted") {
    const formInput = body.eventConfig.formUrl.trim();
    const formId =
      /^https?:\/\/docs\.google\.com\/forms\/d\/([^/]+)/.exec(formInput)?.[1] ??
      formInput;
    return {
      ...base,
      kind: "event",
      eventType: "google-forms-response-submitted",
      eventConfig: {
        provider: "google-forms",
        event: "response_submitted",
        connectorId: crypto.randomUUID(),
        form: {
          id: formId,
          title: "Mock Google Form",
          url: `https://docs.google.com/forms/d/${formId}/edit`,
        },
      },
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (body.eventType === "stripe-invoice-paid") {
    return createStripeInvoicePaidAutomationSummary(base, body);
  }
  return passthroughEventAutomationSummaryForRequest(base, body);
}

function workflowAutomationCreateHandlers() {
  return [
    mockApi(workflowAutomationsContract.create, ({ body, params, respond }) => {
      const workflow = mockWorkflows.find((item) => {
        return item.id === params.workflowId;
      });
      if (!workflow) {
        return respond(404, notFound(params.workflowId));
      }

      const base = {
        id: crypto.randomUUID(),
        ownerUserId: "test-user-123",
        enabled: body.enabled ?? true,
        chatThreadId: "00000000-0000-4000-a000-000000000301",
        nextRunAt: null,
        lastRunAt: null,
        official: null,
      };
      const automation = createWorkflowAutomationSummaryForRequest(base, body);
      workflow.automations = [...workflow.automations, automation];
      return respond(201, automation);
    }),
  ];
}

function setMockWorkflowAutomationEnabled(
  automationId: string,
  enabled: boolean,
) {
  const automations = getMockWorkflowAutomations();
  const automation = automations.find((item) => {
    return item.id === automationId;
  });
  if (!automation) {
    return null;
  }
  const updated = { ...automation, enabled };
  setMockWorkflowAutomations(
    automations.map((item) => {
      return item.id === automationId ? updated : item;
    }),
  );
  return automationSummary(updated);
}

function workflowAutomationEnabledHandlers() {
  return [
    mockApi(workflowAutomationsContract.enable, ({ params, respond }) => {
      const updated = setMockWorkflowAutomationEnabled(params.id, true);
      return updated
        ? respond(200, updated)
        : respond(404, notFoundAutomation());
    }),
    mockApi(workflowAutomationsContract.disable, ({ params, respond }) => {
      const updated = setMockWorkflowAutomationEnabled(params.id, false);
      return updated
        ? respond(200, updated)
        : respond(404, notFoundAutomation());
    }),
  ];
}

function workflowAutomationRunHandlers() {
  return [
    mockApi(
      workflowAutomationsContract.revealWebhookSecret,
      ({ params, respond }) => {
        for (const workflow of mockWorkflows) {
          const detailAutomation = workflow.automations.find((item) => {
            return item.id === params.id;
          });
          if (
            detailAutomation &&
            detailAutomation.kind === "event" &&
            detailAutomation.eventType === "webhook-received"
          ) {
            return respond(200, {
              webhookUrl:
                detailAutomation.webhookUrl ??
                "http://localhost:3000/api/webhooks/workflow-automations/mock",
              webhookSecret:
                detailAutomation.webhookSecret ?? "mock-webhook-secret",
            });
          }
        }

        return respond(404, notFoundAutomation());
      },
    ),
    mockApi(workflowAutomationsContract.run, ({ params, respond }) => {
      if (!mockWorkflowAutomationExists(params.id)) {
        return respond(404, notFoundAutomation());
      }
      return respond(201, {
        runId: "mock-workflow-automation-run",
        chatThreadId: "00000000-0000-4000-a000-000000000301",
      });
    }),
  ];
}

function workflowAutomationUpdateHandlers() {
  return [
    mockApi(workflowAutomationsContract.update, ({ body, params, respond }) => {
      const updatedChatAutomation = updateChatThreadAutomation(
        params.id,
        (automation) => {
          if (automation.kind !== "event" || !("eventConfig" in body)) {
            return automation;
          }
          return {
            ...automation,
            eventConfig: body.eventConfig,
          } as ChatThreadWorkflowAutomation;
        },
      );
      if (updatedChatAutomation) {
        return respond(200, updatedChatAutomation);
      }

      const updatedDetailAutomation = updateDetailAutomation(
        params.id,
        (automation) => {
          if (automation.kind !== "event" || !("eventConfig" in body)) {
            return automation;
          }
          return {
            ...automation,
            eventConfig: body.eventConfig,
          } as WorkflowAutomationSummary;
        },
      );
      return updatedDetailAutomation
        ? respond(200, updatedDetailAutomation)
        : respond(404, notFoundAutomation());
    }),
  ];
}

function workflowAutomationHandlers() {
  return [
    ...workflowAutomationListHandlers(),
    ...workflowAutomationCreateHandlers(),
    ...workflowAutomationEnabledHandlers(),
    ...workflowAutomationRunHandlers(),
    ...workflowAutomationUpdateHandlers(),
  ];
}

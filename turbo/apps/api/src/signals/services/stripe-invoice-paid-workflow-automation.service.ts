import {
  stripeInvoicePaidEventConfigSchema,
  type StripeInvoicePaidEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, isNull } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  loadBuiltinConnectorCredentialConnection,
  loadBuiltinConnectorCredentialValues,
  type BuiltinConnectorCredentialConnection,
} from "./builtin-connector-credential-runtime.service";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

const STRIPE_CONNECTOR_SLUG = "stripe";
const STRIPE_LIVEMODE_VALUE_REF = "$vars.STRIPE_LIVEMODE";
const STRIPE_LIVEMODE_VARIABLE_NAME = "STRIPE_LIVEMODE";

const CONNECT_STRIPE_OAUTH_MESSAGE =
  "Connect Stripe with OAuth in Live mode before adding a Stripe invoice-paid automation";
const RECONNECT_STRIPE_OAUTH_MESSAGE =
  "Reconnect Stripe with OAuth before using Stripe invoice-paid automations";
const STRIPE_OAUTH_REQUIRED_MESSAGE =
  "Stripe invoice-paid automations require OAuth; reconnect Stripe using OAuth";
const STRIPE_LIVE_MODE_REQUIRED_MESSAGE =
  "Stripe invoice-paid automations require Live mode; reconnect Stripe in Live mode";
const STRIPE_BINDING_MISMATCH_MESSAGE =
  "The Stripe connection no longer matches this automation";
const STRIPE_SELECTION_CHANGED_MESSAGE =
  "The selected Stripe account changed; retry the operation";

interface StripeInvoicePaidAutomationBinding {
  readonly connectorId: string;
  readonly stripeAccountId: string;
  readonly mode: "live";
}

type StripeInvoicePaidAutomationReadinessResult =
  | {
      readonly kind: "ok";
      readonly binding: StripeInvoicePaidAutomationBinding;
    }
  | { readonly kind: "bad_request"; readonly message: string };

type ReadyStripeConnectionResult =
  | {
      readonly kind: "ok";
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly stripeAccountId: string;
    }
  | { readonly kind: "bad_request"; readonly message: string };

function badRequest(message: string): ReadyStripeConnectionResult {
  return { kind: "bad_request", message };
}

async function loadReadyStripeConnection(
  args: {
    readonly connectorId: string;
    readonly db: ReadonlyDb;
    readonly missingMessage: string;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<ReadyStripeConnectionResult> {
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  signal.throwIfAborted();
  const loaded = await loadBuiltinConnectorCredentialConnection({
    db: args.db,
    snapshot,
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: STRIPE_CONNECTOR_SLUG,
    connectorId: args.connectorId,
  });
  signal.throwIfAborted();
  if (loaded.kind === "missing") {
    return badRequest(args.missingMessage);
  }
  if (loaded.kind === "unavailable") {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }

  const { connection } = loaded;
  if (connection.runtimeMethod.authMethodId !== "oauth") {
    return badRequest(STRIPE_OAUTH_REQUIRED_MESSAGE);
  }
  if (connection.needsReconnect) {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }
  const stripeAccountId = connection.externalId;
  if (stripeAccountId === null || stripeAccountId.trim().length === 0) {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }
  if (
    !connection.runtimeMethod.method.storage.variables.includes(
      STRIPE_LIVEMODE_VARIABLE_NAME,
    )
  ) {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }

  const values = await loadBuiltinConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [STRIPE_LIVEMODE_VALUE_REF],
  });
  signal.throwIfAborted();
  const livemode = values.get(STRIPE_LIVEMODE_VALUE_REF);
  if (livemode === "false") {
    return badRequest(STRIPE_LIVE_MODE_REQUIRED_MESSAGE);
  }
  if (livemode !== "true") {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }

  return { kind: "ok", connection, stripeAccountId };
}

export async function resolveStripeInvoicePaidAutomationBinding(
  args: {
    readonly db: ReadonlyDb;
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
  signal: AbortSignal,
): Promise<StripeInvoicePaidAutomationReadinessResult> {
  const connectorId = await resolveWorkflowAutomationConnectorId(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.workflowId,
    connectorSlug: STRIPE_CONNECTOR_SLUG,
  });
  signal.throwIfAborted();
  if (connectorId === null) {
    return { kind: "bad_request", message: CONNECT_STRIPE_OAUTH_MESSAGE };
  }
  const ready = await loadReadyStripeConnection(
    {
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId,
      missingMessage: STRIPE_SELECTION_CHANGED_MESSAGE,
    },
    signal,
  );
  if (ready.kind === "bad_request") {
    return ready;
  }
  return {
    kind: "ok",
    binding: {
      connectorId: ready.connection.connectorId,
      stripeAccountId: ready.stripeAccountId,
      mode: "live",
    },
  };
}

export async function validateStripeInvoicePaidAutomationBinding(
  args: {
    readonly db: ReadonlyDb;
    readonly eventConfig: StripeInvoicePaidEventConfig;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<StripeInvoicePaidAutomationReadinessResult> {
  const ready = await loadReadyStripeConnection(
    {
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.eventConfig.connectorId,
      missingMessage: STRIPE_BINDING_MISMATCH_MESSAGE,
    },
    signal,
  );
  if (ready.kind === "bad_request") {
    return ready;
  }
  if (ready.stripeAccountId !== args.eventConfig.stripeAccountId) {
    return { kind: "bad_request", message: STRIPE_BINDING_MISMATCH_MESSAGE };
  }
  return {
    kind: "ok",
    binding: {
      connectorId: ready.connection.connectorId,
      stripeAccountId: ready.stripeAccountId,
      mode: "live",
    },
  };
}

interface StripeAutomationProjectionRow {
  readonly id: string;
  readonly workflowId: string;
  readonly eventConfig: unknown;
  readonly eventConnectorId: string | null;
}

async function reprojectStripeAutomation(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly automation: StripeAutomationProjectionRow;
    readonly readinessByConnectorId: Map<
      string,
      StripeInvoicePaidAutomationReadinessResult
    >;
  },
  signal: AbortSignal,
): Promise<void> {
  const connectorId = await resolveWorkflowAutomationConnectorId(db, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.automation.workflowId,
    connectorSlug: STRIPE_CONNECTOR_SLUG,
  });
  signal.throwIfAborted();

  if (connectorId === null) {
    if (args.automation.eventConnectorId !== null) {
      await db
        .update(workflowAutomations)
        .set({ eventConnectorId: null })
        .where(eq(workflowAutomations.id, args.automation.id));
    }
    return;
  }

  let readiness = args.readinessByConnectorId.get(connectorId);
  if (readiness === undefined) {
    const ready = await loadReadyStripeConnection(
      {
        db,
        orgId: args.orgId,
        userId: args.userId,
        connectorId,
        missingMessage: STRIPE_SELECTION_CHANGED_MESSAGE,
      },
      signal,
    );
    readiness =
      ready.kind === "ok"
        ? {
            kind: "ok",
            binding: {
              connectorId: ready.connection.connectorId,
              stripeAccountId: ready.stripeAccountId,
              mode: "live",
            },
          }
        : ready;
    args.readinessByConnectorId.set(connectorId, readiness);
  }

  if (readiness.kind !== "ok") {
    if (args.automation.eventConnectorId !== connectorId) {
      await db
        .update(workflowAutomations)
        .set({ eventConnectorId: connectorId })
        .where(eq(workflowAutomations.id, args.automation.id));
    }
    return;
  }

  const config = stripeInvoicePaidEventConfigSchema.parse(
    args.automation.eventConfig,
  );
  const binding = readiness.binding;
  if (
    args.automation.eventConnectorId === connectorId &&
    config.connectorId === binding.connectorId &&
    config.stripeAccountId === binding.stripeAccountId &&
    config.mode === binding.mode
  ) {
    return;
  }
  await db
    .update(workflowAutomations)
    .set({
      eventConnectorId: connectorId,
      eventConfig: { ...config, ...binding },
    })
    .where(eq(workflowAutomations.id, args.automation.id));
}

export async function reprojectStripeInvoicePaidAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      workflowId: workflowAutomations.workflowId,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "stripe-invoice-paid"),
      ),
    );
  signal.throwIfAborted();
  const readinessByConnectorId = new Map<
    string,
    StripeInvoicePaidAutomationReadinessResult
  >();
  for (const automation of automations) {
    await reprojectStripeAutomation(
      db,
      { ...args, automation, readinessByConnectorId },
      signal,
    );
    signal.throwIfAborted();
  }
}

export async function repairMissingStripeInvoicePaidAutomationProjection(
  db: Db,
  args: {
    readonly automationId: string;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const [automation] = await db
    .select({
      id: workflowAutomations.id,
      workflowId: workflowAutomations.workflowId,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "stripe-invoice-paid"),
        isNull(workflowAutomations.eventConnectorId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!automation) {
    return;
  }
  await reprojectStripeAutomation(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      automation,
      readinessByConnectorId: new Map(),
    },
    signal,
  );
}

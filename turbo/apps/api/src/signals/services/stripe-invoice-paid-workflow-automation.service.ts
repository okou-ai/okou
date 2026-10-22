import {
  stripeInvoicePaidEventConfigSchema,
  type StripeInvoicePaidEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { and, eq, isNull } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import {
  builtinConnectorCredentialConnectionReadPlan,
  builtinConnectorCredentialConnectionFromRow,
  builtinConnectorCredentialValuesReadPlan,
  builtinConnectorCredentialValuesFromRows,
  type BuiltinConnectorCredentialConnection,
  type BuiltinConnectorCredentialConnectionResult,
} from "./builtin-connector-credential-runtime.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeAuthSelectionReadPlan,
  connectorRuntimeAuthSelectionFromRows,
} from "./connector-catalog-slug-source.service";

const STRIPE_CONNECTOR_SLUG = "stripe";
const STRIPE_LIVEMODE_VALUE_REF = "$vars.STRIPE_LIVEMODE";
const STRIPE_LIVEMODE_VARIABLE_NAME = "STRIPE_LIVEMODE";

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

export function stripeConnectionReadiness(
  loaded: BuiltinConnectorCredentialConnectionResult,
  missingMessage: string,
): ReadyStripeConnectionResult {
  if (loaded.kind === "missing") {
    return badRequest(missingMessage);
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

  return { kind: "ok", connection, stripeAccountId };
}

export function stripeBindingConnectionReadiness(
  loaded: BuiltinConnectorCredentialConnectionResult,
): ReadyStripeConnectionResult {
  return stripeConnectionReadiness(loaded, STRIPE_BINDING_MISMATCH_MESSAGE);
}

export function stripeLiveModeReadinessMessage(
  value: string | undefined,
): string | null {
  if (value === "false") {
    return STRIPE_LIVE_MODE_REQUIRED_MESSAGE;
  }
  return value === "true" ? null : RECONNECT_STRIPE_OAUTH_MESSAGE;
}

export function stripeLiveModeValuesPlan(
  connection: BuiltinConnectorCredentialConnection,
) {
  return builtinConnectorCredentialValuesReadPlan({
    connection,
    valueRefs: [STRIPE_LIVEMODE_VALUE_REF],
  });
}

export function stripeLiveBindingMatches(
  ready: { readonly stripeAccountId: string },
  config: StripeInvoicePaidEventConfig,
  values: ReadonlyMap<string, string>,
): boolean {
  return (
    stripeLiveModeReadinessMessage(values.get(STRIPE_LIVEMODE_VALUE_REF)) ===
      null && ready.stripeAccountId === config.stripeAccountId
  );
}

interface StripeAutomationProjectionRow {
  readonly id: string;
  readonly workflowId: string;
  readonly eventConfig: unknown;
  readonly eventConnectorId: string | null;
}

interface StripeAutomationProjectionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly automation: StripeAutomationProjectionRow;
  readonly readinessByConnectorId: Map<
    string,
    StripeInvoicePaidAutomationReadinessResult
  >;
  /**
   * Repair publishes only while the automation is still unbound, so a
   * reprojection that bound it after the read below is never overwritten.
   */
  readonly onlyIfUnbound?: boolean;
}

function stripeAutomationProjectionTarget(
  args: Pick<StripeAutomationProjectionArgs, "automation" | "onlyIfUnbound">,
) {
  return and(
    eq(workflowAutomations.id, args.automation.id),
    args.onlyIfUnbound === true
      ? isNull(workflowAutomations.eventConnectorId)
      : undefined,
  );
}

function stripeAutomationConnectorInput(
  args: Pick<StripeAutomationProjectionArgs, "orgId" | "userId" | "automation">,
) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.automation.workflowId,
    connectorSlug: STRIPE_CONNECTOR_SLUG,
  };
}

function stripeAutomationSelectionJoin(
  input: ReturnType<typeof stripeAutomationConnectorInput>,
) {
  return and(
    eq(
      chatThreadConnectorSelections.chatThreadId,
      workflowUserAutomationThreads.chatThreadId,
    ),
    eq(chatThreadConnectorSelections.connectorSlug, input.connectorSlug),
  );
}

function stripeAutomationSelectionThreadCondition(
  input: ReturnType<typeof stripeAutomationConnectorInput>,
) {
  return and(
    eq(workflowUserAutomationThreads.orgId, input.orgId),
    eq(workflowUserAutomationThreads.userId, input.userId),
    eq(workflowUserAutomationThreads.workflowId, input.workflowId),
  );
}

function stripeAutomationDefaultAccountCondition(
  input: ReturnType<typeof stripeAutomationConnectorInput>,
) {
  return and(
    eq(connectors.orgId, input.orgId),
    eq(connectors.userId, input.userId),
    eq(connectors.connectorSlug, input.connectorSlug),
    eq(connectors.isDefault, true),
  );
}

function stripeAutomationCatalogPlan() {
  return connectorRuntimeAuthSelectionReadPlan({
    connectorSlugs: [STRIPE_CONNECTOR_SLUG],
  });
}

function stripeAutomationReadinessFromConnection(
  ready: ReadyStripeConnectionResult,
): StripeInvoicePaidAutomationReadinessResult {
  return ready.kind === "ok"
    ? {
        kind: "ok",
        binding: {
          connectorId: ready.connection.connectorId,
          stripeAccountId: ready.stripeAccountId,
          mode: "live",
        },
      }
    : ready;
}

function stripeAutomationProjectionUpdate(
  automation: StripeAutomationProjectionRow,
  connectorId: string,
  readiness: StripeInvoicePaidAutomationReadinessResult,
) {
  if (readiness.kind !== "ok") {
    if (automation.eventConnectorId !== connectorId) {
      return { eventConnectorId: connectorId };
    }
    return null;
  }

  const config = stripeInvoicePaidEventConfigSchema.parse(
    automation.eventConfig,
  );
  const binding = readiness.binding;
  if (
    automation.eventConnectorId === connectorId &&
    config.connectorId === binding.connectorId &&
    config.stripeAccountId === binding.stripeAccountId &&
    config.mode === binding.mode
  ) {
    return null;
  }
  return {
    eventConnectorId: connectorId,
    eventConfig: { ...config, ...binding },
  };
}

const reprojectStripeAutomation$ = command(
  async (
    { set },
    args: StripeAutomationProjectionArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const target = stripeAutomationProjectionTarget(args);
    const selectionDb = db;
    const selectionInput = stripeAutomationConnectorInput(args);
    const connectorId = await (async (): Promise<string | null> => {
      const [selection] = await selectionDb
        .select({ connectorId: chatThreadConnectorSelections.connectorId })
        .from(workflowUserAutomationThreads)
        .innerJoin(
          chatThreadConnectorSelections,
          stripeAutomationSelectionJoin(selectionInput),
        )
        .where(stripeAutomationSelectionThreadCondition(selectionInput))
        .limit(1);
      if (selection) {
        return selection.connectorId;
      }
      const [defaultAccount] = await selectionDb
        .select({ connectorId: connectors.id })
        .from(connectors)
        .where(stripeAutomationDefaultAccountCondition(selectionInput))
        .limit(1);
      return defaultAccount?.connectorId ?? null;
    })();
    signal.throwIfAborted();

    if (connectorId === null) {
      if (args.automation.eventConnectorId !== null) {
        await db
          .update(workflowAutomations)
          .set({ eventConnectorId: null })
          .where(target);
      }
      return;
    }

    let readiness = args.readinessByConnectorId.get(connectorId);
    if (readiness === undefined) {
      const ready = await (async (
        readSignal: AbortSignal,
      ): Promise<ReadyStripeConnectionResult> => {
        const catalogDb = db;
        const input = stripeReadinessInput(args, connectorId);
        const catalogPlan = stripeAutomationCatalogPlan();
        const snapshot = connectorRuntimeAuthSelectionFromRows(
          await catalogDb
            .select(catalogPlan.columns)
            .from(connectorCatalog)
            .leftJoin(connectorCatalogEntries, catalogPlan.join)
            .where(connectorCatalogCurrentWhere()),
          catalogPlan.requestedConnectorSlugs,
          catalogPlan.firewallConnectorSlugs,
        );
        readSignal.throwIfAborted();
        const connectionInput = {
          snapshot,
          orgId: input.orgId,
          userId: input.userId,
          connectorSlug: STRIPE_CONNECTOR_SLUG,
          connectorId: input.connectorId,
        };
        const connectionPlan =
          builtinConnectorCredentialConnectionReadPlan(connectionInput);
        const loaded = builtinConnectorCredentialConnectionFromRow(
          connectionInput,
          (
            await catalogDb
              .select(connectionPlan.columns)
              .from(connectors)
              .where(connectionPlan.condition)
              .limit(1)
          )[0],
        );
        readSignal.throwIfAborted();
        const ready = stripeConnectionReadiness(loaded, input.missingMessage);
        if (ready.kind === "bad_request") {
          return ready;
        }
        const { connection, stripeAccountId } = ready;
        const valuesInput = {
          connection,
          valueRefs: [STRIPE_LIVEMODE_VALUE_REF],
        };
        const valuesPlan =
          builtinConnectorCredentialValuesReadPlan(valuesInput);
        const values =
          valuesPlan === null
            ? new Map<string, string>()
            : await builtinConnectorCredentialValuesFromRows(
                valuesInput,
                await catalogDb
                  .select(valuesPlan.secretColumns)
                  .from(secrets)
                  .where(valuesPlan.secretCondition)
                  .unionAll(
                    catalogDb
                      .select(valuesPlan.variableColumns)
                      .from(variables)
                      .where(valuesPlan.variableCondition),
                  ),
              );
        readSignal.throwIfAborted();
        const livemode = values.get(STRIPE_LIVEMODE_VALUE_REF);
        const modeError = stripeLiveModeReadinessMessage(livemode);
        if (modeError !== null) {
          return badRequest(modeError);
        }

        return { kind: "ok", connection, stripeAccountId };
      })(signal);
      readiness = stripeAutomationReadinessFromConnection(ready);
      args.readinessByConnectorId.set(connectorId, readiness);
    }

    const update = stripeAutomationProjectionUpdate(
      args.automation,
      connectorId,
      readiness,
    );
    if (update !== null) {
      await db.update(workflowAutomations).set(update).where(target);
    }
  },
);

interface StripeAutomationOwnerArgs {
  readonly orgId: string;
  readonly userId: string;
}

function stripeAutomationOwnerColumns() {
  return {
    id: workflowAutomations.id,
    workflowId: workflowAutomations.workflowId,
    eventConfig: workflowAutomations.eventConfig,
    eventConnectorId: workflowAutomations.eventConnectorId,
  };
}

function stripeAutomationOwnerCondition(args: StripeAutomationOwnerArgs) {
  return and(
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.kind, "event"),
    eq(workflowAutomations.eventType, "stripe-invoice-paid"),
  );
}

function stripeReadinessInput(
  args: StripeAutomationOwnerArgs,
  connectorId: string,
) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    connectorId,
    missingMessage: STRIPE_SELECTION_CHANGED_MESSAGE,
  };
}

function stripeConnectionInput(
  snapshot: ReturnType<typeof connectorRuntimeAuthSelectionFromRows>,
  input: ReturnType<typeof stripeReadinessInput>,
) {
  return {
    snapshot,
    orgId: input.orgId,
    userId: input.userId,
    connectorSlug: STRIPE_CONNECTOR_SLUG,
    connectorId: input.connectorId,
  };
}

function stripeValuesInput(connection: BuiltinConnectorCredentialConnection) {
  return {
    connection,
    valueRefs: [STRIPE_LIVEMODE_VALUE_REF],
  };
}

function stripeLiveReadyResult(
  livemode: string | undefined,
  connection: BuiltinConnectorCredentialConnection,
  stripeAccountId: string,
): ReadyStripeConnectionResult {
  const modeError = stripeLiveModeReadinessMessage(livemode);
  if (modeError !== null) {
    return badRequest(modeError);
  }
  return { kind: "ok", connection, stripeAccountId };
}

/** Pure subqueries retain Drizzle column decoders; owners execute every read. */
export function stripeAccountAutomationsReadPlan(
  args: StripeAutomationOwnerArgs,
) {
  return {
    from: workflowAutomations,
    cache: new Map<string, StripeInvoicePaidAutomationReadinessResult>(),
    query: new QueryBuilder()
      .select(stripeAutomationOwnerColumns())
      .from(workflowAutomations)
      .where(stripeAutomationOwnerCondition(args))
      .as("stripe_owner_automations"),
  };
}

export function stripeAccountAutomationSelectionPlan(
  args: StripeAutomationOwnerArgs,
  automation: StripeAutomationProjectionRow,
) {
  const item = { ...args, automation };
  const input = stripeAutomationConnectorInput(item);
  return {
    selected: new QueryBuilder()
      .select({ connectorId: chatThreadConnectorSelections.connectorId })
      .from(workflowUserAutomationThreads)
      .innerJoin(
        chatThreadConnectorSelections,
        stripeAutomationSelectionJoin(input),
      )
      .where(stripeAutomationSelectionThreadCondition(input))
      .limit(1)
      .as("stripe_selection"),
    defaultAccount: new QueryBuilder()
      .select({ connectorId: connectors.id })
      .from(connectors)
      .where(stripeAutomationDefaultAccountCondition(input))
      .limit(1)
      .as("stripe_default"),
    target: stripeAutomationProjectionTarget(item),
  };
}

export function stripeAccountCatalogReadPlan() {
  return {
    ...stripeAutomationCatalogPlan(),
    from: connectorCatalog,
    joinTable: connectorCatalogEntries,
    where: connectorCatalogCurrentWhere(),
  };
}

export function stripeAccountConnectionReadPlan(
  args: StripeAutomationOwnerArgs,
  connectorId: string,
  rows: Parameters<typeof connectorRuntimeAuthSelectionFromRows>[0],
) {
  const catalogPlan = stripeAutomationCatalogPlan();
  const snapshot = connectorRuntimeAuthSelectionFromRows(
    rows,
    catalogPlan.requestedConnectorSlugs,
    catalogPlan.firewallConnectorSlugs,
  );
  const input = stripeConnectionInput(
    snapshot,
    stripeReadinessInput(args, connectorId),
  );
  const plan = builtinConnectorCredentialConnectionReadPlan(input);
  return {
    input,
    query: new QueryBuilder()
      .select({
        ...plan.columns,
        stateRevision: plan.columns.stateRevision.as("state_revision"),
      })
      .from(connectors)
      .where(plan.condition)
      .limit(1)
      .as("stripe_connection"),
  };
}

export function stripeAccountReadiness(
  input: ReturnType<typeof stripeAccountConnectionReadPlan>["input"],
  row: Parameters<typeof builtinConnectorCredentialConnectionFromRow>[1],
) {
  return stripeConnectionReadiness(
    builtinConnectorCredentialConnectionFromRow(input, row),
    STRIPE_SELECTION_CHANGED_MESSAGE,
  );
}

export function stripeAccountLiveModeReadPlan(
  connection: BuiltinConnectorCredentialConnection,
) {
  const input = stripeValuesInput(connection);
  const plan = builtinConnectorCredentialValuesReadPlan(input);
  // This plan always requests the one named Live-mode variable, so it is nonempty.
  if (plan === null) {
    throw new Error("Expected Stripe Live-mode variable query");
  }
  return {
    input,
    query: new QueryBuilder()
      .select(plan.secretColumns)
      .from(secrets)
      .where(plan.secretCondition)
      .unionAll(
        new QueryBuilder()
          .select(plan.variableColumns)
          .from(variables)
          .where(plan.variableCondition),
      )
      .as("stripe_live_mode"),
  };
}

export function stripeAccountProjectionUpdate(
  automation: StripeAutomationProjectionRow,
  connectorId: string | null,
  readiness: StripeInvoicePaidAutomationReadinessResult | undefined,
) {
  if (connectorId === null) {
    return automation.eventConnectorId === null
      ? null
      : { eventConnectorId: null };
  }
  if (readiness === undefined) {
    throw new Error("Expected Stripe account readiness before projection");
  }
  return stripeAutomationProjectionUpdate(automation, connectorId, readiness);
}

export function stripeAccountProjectionReadiness(
  ready: ReadyStripeConnectionResult,
  values: ReadonlyMap<string, string>,
): StripeInvoicePaidAutomationReadinessResult {
  return stripeAutomationReadinessFromConnection(
    ready.kind === "bad_request"
      ? ready
      : stripeLiveReadyResult(
          values.get(STRIPE_LIVEMODE_VALUE_REF),
          ready.connection,
          ready.stripeAccountId,
        ),
  );
}

export const repairMissingStripeInvoicePaidAutomationProjection$ = command(
  async (
    { get, set },
    args: {
      readonly automationId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
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
    await set(
      reprojectStripeAutomation$,
      {
        orgId: args.orgId,
        userId: args.userId,
        automation,
        readinessByConnectorId: new Map(),
        onlyIfUnbound: true,
      },
      signal,
    );
  },
);

import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { computed, type Computed } from "ccstate";
import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { performance } from "node:perf_hooks";
import { array, object, unknown as zUnknown } from "zod";
import {
  withPgPoolAcquisitionCapture,
  type PgPoolAcquisitionCapture,
} from "../../lib/db-instrumentation";
import {
  nullableDriverValueDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import type { ClaimExecutionContextRun } from "./claim-execution-context";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
import {
  connectorContextDuration,
  connectorEnvironmentRead,
  materializeConnectorEnvironment,
} from "./execution-connector-environment.service";
import { userFeatureSwitchRowCondition } from "./feature-switch-scope";
import { memberModelBootstrapFromSources } from "./model-bootstrap.service";
import { memberModelSourcesAggregate } from "./model-source-context.service";

const featureColumns = Object.freeze({
  userId: userFeatureSwitches.userId,
  switches: userFeatureSwitches.switches,
});
const preferenceColumns = Object.freeze({
  timezone: orgMembersMetadata.timezone,
});
const registrationColumns = Object.freeze({
  payload: agentRunConnectorDiagnosticRegistrations.payload,
});
const selectionColumns = Object.freeze({
  connectorId: chatThreadConnectorSelections.connectorId,
  connectorSlug: chatThreadConnectorSelections.connectorSlug,
  customConnectorId: chatThreadConnectorSelections.customConnectorId,
});
const overrideColumns = Object.freeze({
  connectorId: chatThreadConnectorAccessOverrides.connectorId,
  enabled: chatThreadConnectorAccessOverrides.enabled,
});
const claimInputsDecoder = zodDriverValueDecoder(
  object({
    features: array(contextProjectionSchema(featureColumns)),
    preferences: array(contextProjectionSchema(preferenceColumns)),
    registrations: array(contextProjectionSchema(registrationColumns)),
    selections: array(contextProjectionSchema(selectionColumns)),
    accessOverrides: array(contextProjectionSchema(overrideColumns)),
    modelSources: zUnknown(),
  }),
);

/** Scalar groups have independent cardinality; none multiplies account rows. */
function claimInputProjection(
  run: ClaimExecutionContextRun,
  modelSources: SQLWrapper,
) {
  const builder = new QueryBuilder();
  const features = builder
    .select({
      payload: contextJsonProjection(featureColumns)
        .mapWith(zodDriverValueDecoder(contextProjectionSchema(featureColumns)))
        .as("payload"),
    })
    .from(userFeatureSwitches)
    .where(userFeatureSwitchRowCondition(run.orgId, run.userId));
  const preferences = builder
    .select({
      payload: contextJsonProjection(preferenceColumns)
        .mapWith(
          zodDriverValueDecoder(contextProjectionSchema(preferenceColumns)),
        )
        .as("payload"),
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, run.orgId),
        eq(orgMembersMetadata.userId, run.userId),
      ),
    );
  const registrations = builder
    .select({
      payload: contextJsonProjection(registrationColumns)
        .mapWith(
          zodDriverValueDecoder(contextProjectionSchema(registrationColumns)),
        )
        .as("payload"),
    })
    .from(agentRunConnectorDiagnosticRegistrations)
    .where(eq(agentRunConnectorDiagnosticRegistrations.runId, run.id));
  const selections = builder
    .select({
      payload: contextJsonProjection(selectionColumns)
        .mapWith(
          zodDriverValueDecoder(contextProjectionSchema(selectionColumns)),
        )
        .as("payload"),
    })
    .from(chatThreadConnectorSelections)
    .where(
      run.chatThreadId === null
        ? sql`false`
        : eq(chatThreadConnectorSelections.chatThreadId, run.chatThreadId),
    );
  const overrides = builder
    .select({
      payload: contextJsonProjection(overrideColumns)
        .mapWith(
          zodDriverValueDecoder(contextProjectionSchema(overrideColumns)),
        )
        .as("payload"),
    })
    .from(chatThreadConnectorAccessOverrides)
    .where(
      run.chatThreadId === null
        ? sql`false`
        : eq(chatThreadConnectorAccessOverrides.chatThreadId, run.chatThreadId),
    );
  // Emit the same request-owned facts once, including when there are no accounts.
  // Avoid repeating/decoding Thread and feature payloads for every saved account.
  return sql`CASE WHEN row_number() OVER () = 1 THEN jsonb_build_object(
    'features', ${contextJsonRows(features)},
    'preferences', ${contextJsonRows(preferences)},
    'registrations', ${contextJsonRows(registrations)},
    'selections', ${contextJsonRows(selections)},
    'accessOverrides', ${contextJsonRows(overrides)},
    'modelSources', ${modelSources}
  ) ELSE NULL END`.mapWith(nullableDriverValueDecoder(claimInputsDecoder));
}

/** Fresh, authorized Claim input only; never persisted or shared with another Run. */
export function createClaimSourceContext(
  run$: Computed<Promise<ClaimExecutionContextRun>>,
) {
  return computed(async (get) => {
    const run = await get(run$);
    const db = get(db$);
    if (run.agentId === null) {
      const [row] = await db
        .select(preferenceColumns)
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, run.orgId),
            eq(orgMembersMetadata.userId, run.userId),
          ),
        );
      return {
        kind: "model-only" as const,
        timezone: row?.timezone ?? undefined,
      };
    }
    // run.vars is authoritative; only connector values need fresh reconstruction.
    const source = connectorEnvironmentRead(run, false);
    const needsMemberModel =
      run.modelProvider !== null && run.modelProvider !== "built-in";
    const modelSources = memberModelSourcesAggregate(
      run.orgId,
      run.userId,
      run.id,
    );
    const modelRows = new QueryBuilder()
      .select({ payload: modelSources.payload })
      .from(modelProviders)
      .leftJoin(modelProviderAccounts, modelSources.joins.account)
      .leftJoin(modelProviderAccountSecrets, modelSources.joins.secret)
      .where(modelSources.joins.provider);
    const modelProjection = needsMemberModel ? sql`(${modelRows})` : sql`NULL`;
    const capture: PgPoolAcquisitionCapture = { acquisitions: [] };
    const startedAt = performance.now();
    const rows = await withPgPoolAcquisitionCapture(capture, async () => {
      return await db
        .select({
          account: source.account,
          variableValues: source.variableValues,
          connectorVariables: source.connectorVariables,
          credentials: source.credentials,
          automaticOAuthBindingId: source.automaticOAuthBindingId,
          inputs: claimInputProjection(run, modelProjection),
        })
        .from(source);
    });
    const query = connectorContextDuration(startedAt);
    const inputs = rows.flatMap((row) => {
      return row.inputs === null ? [] : [row.inputs];
    });
    const [input] = inputs;
    if (inputs.length !== 1 || !input) {
      throw new Error(
        "Claim source capture returned invalid input cardinality",
      );
    }
    const [preferences] = input.preferences;
    return {
      kind: "agent" as const,
      ...input,
      timezone: preferences?.timezone ?? undefined,
      memberModels: needsMemberModel
        ? memberModelBootstrapFromSources(
            modelSources.decode(input.modelSources),
          )
        : undefined,
      environment: materializeConnectorEnvironment(rows, {
        query,
        acquisitions: capture.acquisitions,
      }),
    };
  });
}

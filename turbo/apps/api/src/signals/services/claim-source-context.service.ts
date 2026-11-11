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
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { userMessageDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
import { computed, type Computed } from "ccstate";
import { and, asc, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
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
  contextColumnSchema,
} from "./context-rowset";
import {
  connectorContextDuration,
  connectorEnvironmentRead,
  materializeConnectorEnvironment,
} from "./execution-connector-environment.service";
import { userFeatureSwitchRowCondition } from "./feature-switch-scope";
import { memberModelBootstrapFromSources } from "./model-bootstrap.service";
import { memberModelSourcesAggregate } from "./model-source-context.service";
import {
  globalModelCaptureSchema,
  globalModelContextRead,
} from "./execution-global-model-context.service";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";

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
const initialInputColumns = Object.freeze({
  contextType: chatEvents.contextType,
  contextId: chatEvents.contextId,
  chatThreadId: chatEvents.chatThreadId,
  captureId: chatNetworkBodyCaptures.chatEventId,
  phoneChannel: chatAgentphoneContext.channel,
  feishuPlatform: feishuOrgInstallations.platform,
});
const initialInputSchema = object({
  userMessage: userMessageDocumentSchema.nullable(),
  contextType: contextColumnSchema(initialInputColumns.contextType),
  contextId: contextColumnSchema(initialInputColumns.contextId),
  chatThreadId: contextColumnSchema(initialInputColumns.chatThreadId),
  captureId: contextColumnSchema(initialInputColumns.captureId).nullable(),
  phoneChannel: contextColumnSchema(
    initialInputColumns.phoneChannel,
  ).nullable(),
  feishuPlatform: contextColumnSchema(
    initialInputColumns.feishuPlatform,
  ).nullable(),
});
const initialInputDecoder = zodDriverValueDecoder(initialInputSchema);
const claimInputsDecoder = zodDriverValueDecoder(
  object({
    features: array(contextProjectionSchema(featureColumns)),
    preferences: array(contextProjectionSchema(preferenceColumns)),
    registrations: array(contextProjectionSchema(registrationColumns)),
    selections: array(contextProjectionSchema(selectionColumns)),
    accessOverrides: array(contextProjectionSchema(overrideColumns)),
    modelSources: zUnknown(),
    globalModels: globalModelCaptureSchema,
    initialInput: initialInputSchema.nullable(),
  }),
);

/** First canonical Run input and its nullable integration facts share this capture. */
function claimInitialInputRead(run: ClaimExecutionContextRun) {
  const query = new QueryBuilder()
    .select({
      payload:
        sql`${contextJsonProjection(initialInputColumns)} || jsonb_build_object(
        'userMessage', ${canonicalChatEventUserMessage()}
      )`
          .mapWith(initialInputDecoder)
          .as("payload"),
    })
    .from(chatEvents)
    .leftJoin(
      chatNetworkBodyCaptures,
      and(
        eq(chatNetworkBodyCaptures.chatEventId, chatEvents.revokesEventId),
        eq(chatNetworkBodyCaptures.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .leftJoin(
      chatAgentphoneContext,
      and(
        eq(chatEvents.contextType, "agentphone"),
        eq(chatAgentphoneContext.id, chatEvents.contextId),
        eq(chatAgentphoneContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .leftJoin(
      chatFeishuContext,
      and(
        eq(chatEvents.contextType, "feishu"),
        eq(chatFeishuContext.id, chatEvents.contextId),
        eq(chatFeishuContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .leftJoin(
      feishuOrgInstallations,
      and(
        eq(feishuOrgInstallations.id, chatFeishuContext.installationId),
        eq(feishuOrgInstallations.orgId, run.orgId),
      ),
    )
    .where(
      and(
        eq(chatEvents.runId, run.id),
        inArray(chatEvents.eventType, ["input.prompt", "input.automation"]),
      ),
    )
    .orderBy(asc(chatEvents.seqId))
    .limit(1);
  return sql`(${query})`.mapWith(
    nullableDriverValueDecoder(initialInputDecoder),
  );
}

/** Scalar groups have independent cardinality; none multiplies account rows. */
function claimInputProjection(
  run: ClaimExecutionContextRun,
  modelSources: SQLWrapper,
  admittedBindings: boolean,
  globalModels: SQLWrapper,
  initialInput: SQLWrapper,
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
    .where(
      admittedBindings
        ? eq(agentRunConnectorDiagnosticRegistrations.runId, run.id)
        : sql`false`,
    );
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
      !admittedBindings || run.chatThreadId === null
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
    'modelSources', ${modelSources},
    'globalModels', ${globalModels},
    'initialInput', ${initialInput}
  ) ELSE NULL END`.mapWith(nullableDriverValueDecoder(claimInputsDecoder));
}

/** Fresh, authorized Claim input only; never persisted or shared with another Run. */
export function createClaimSourceContext(
  run$: Computed<Promise<ClaimExecutionContextRun>>,
  admittedBindings$: Computed<Promise<boolean>>,
) {
  return computed(async (get) => {
    const [run, admittedBindings] = await Promise.all([
      get(run$),
      get(admittedBindings$),
    ]);
    const db = get(db$);
    const globalModels = globalModelContextRead({
      kind: "claim",
      modelKeyId:
        run.modelProvider === "built-in" ? run.builtInModelKeyId : null,
      hasModel: run.modelProvider !== null,
      hasAgent: run.agentId !== null,
    });
    const initialInput = claimInitialInputRead(run);
    if (run.agentId === null) {
      const [row] = await db
        .select({ ...preferenceColumns, globalModels, initialInput })
        .from(sql`(values (1)) as claim_seed(value)`)
        .leftJoin(
          orgMembersMetadata,
          and(
            eq(orgMembersMetadata.orgId, run.orgId),
            eq(orgMembersMetadata.userId, run.userId),
          ),
        );
      if (!row) {
        throw new Error("Claim model source capture returned no row");
      }
      return {
        kind: "model-only" as const,
        timezone: row.timezone ?? undefined,
        globalModels: row.globalModels,
        initialInput: row.initialInput,
      };
    }
    // run.vars is authoritative; only connector values need fresh reconstruction.
    const source = connectorEnvironmentRead(run);
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
      .where(
        and(
          modelSources.joins.provider,
          run.modelProviderId === null
            ? sql`false`
            : eq(modelProviderAccounts.id, run.modelProviderId),
        ),
      );
    const modelProjection = needsMemberModel ? sql`(${modelRows})` : sql`NULL`;
    const capture: PgPoolAcquisitionCapture = { acquisitions: [] };
    const startedAt = performance.now();
    const rows = await withPgPoolAcquisitionCapture(capture, async () => {
      return await db
        .select({
          account: source.account,
          connectorVariables: source.connectorVariables,
          credentials: source.credentials,
          automaticOAuthBindingId: source.automaticOAuthBindingId,
          inputs: claimInputProjection(
            run,
            modelProjection,
            admittedBindings,
            globalModels,
            initialInput,
          ),
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

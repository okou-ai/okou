import {
  logsByIdContract,
  logsListContract,
} from "@okouai/api-contracts/contracts/logs";
import type { z } from "zod";
import { emailUnsubscribeContract } from "@okouai/api-contracts/contracts/email-unsubscribe";
import { pushSubscriptionsContract } from "@okouai/api-contracts/contracts/push-subscriptions";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import {
  isBuiltInModelProviderType,
  type ModelProviderType,
  type OrgModelPoliciesResponse,
  type UpsertModelProviderRequest,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowFileEntry,
} from "@okouai/api-contracts/contracts/workflows";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import {
  modelProvidersByTypeContract,
  modelProvidersMainContract,
} from "@okouai/api-contracts/contracts/model-provider-routes";
import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { orgLogoContract } from "@okouai/api-contracts/contracts/org-logo";
import {
  userPreferencesContract,
  updateUserPreferencesRequestSchema,
} from "@okouai/api-contracts/contracts/user-preferences";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
import { emailUnsubscribeRoutes } from "../../email-unsubscribe";
import { userExportRoutes } from "../../user-export";
import { logsRoutes } from "../../logs";
import { meModelProvidersDeleteRoutes } from "../../me-model-providers-delete";
import { meModelProvidersListRoutes } from "../../me-model-providers-list";
import { meModelProvidersResetSubscriptionRoutes } from "../../me-model-providers-reset-subscription";
import { meModelProvidersUpsertRoutes } from "../../me-model-providers-upsert";
import { modelPoliciesRoutes } from "../../model-policies";
import { modelProvidersRoutes } from "../../model-providers";
import { orgLogoRoutes } from "../../org-logo";
import { pushSubscriptionsRoutes } from "../../push-subscriptions";
import { userPreferencesRoutes } from "../../user-preferences";
import { workflowsRoutes } from "../../workflows";

const personalModelProvidersMainTestRoutes = Object.freeze([
  ...meModelProvidersListRoutes,
  ...meModelProvidersUpsertRoutes,
]);

const personalModelProvidersByTypeTestRoutes = Object.freeze([
  ...meModelProvidersDeleteRoutes,
  ...meModelProvidersResetSubscriptionRoutes,
]);

interface AuthHeaders {
  readonly authorization?: string;
}

type UpdateUserPreferencesInput = z.input<
  typeof updateUserPreferencesRequestSchema
>;

type LogsListQuery = z.input<(typeof logsListContract.list)["query"]>;

interface ClerkOrg {
  readonly imageUrl: string | null;
  readonly hasImage: boolean;
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser | null,
): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function workflowFiles(content: string): WorkflowFileEntry[] {
  return [{ path: "SKILL.md", content }];
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function bodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.alloc(0);
}

function asyncIterableOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

async function requestLogsList<TStatus extends 200 | 400 | 401 | 403>(
  context: TestContext,
  actor: ApiTestUser | null,
  query: LogsListQuery,
  statuses: readonly TStatus[],
) {
  return await accept(
    setupApp({ context, routes: logsRoutes })(logsListContract).list({
      headers: authenticate(context, actor),
      query,
    }),
    statuses,
  );
}

export function createMiscRoutesApi(context: TestContext) {
  const s3Objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const key = typeof input.Key === "string" ? input.Key : "";
    const name = commandName(command);
    if (name === "PutObjectCommand") {
      s3Objects.set(key, bodyBuffer(input.Body));
      return Promise.resolve({});
    }
    if (name === "GetObjectCommand") {
      const body = s3Objects.get(key);
      return Promise.resolve(
        body ? { Body: asyncIterableOf(body) } : { Body: undefined },
      );
    }
    if (name === "HeadObjectCommand") {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });

  return {
    putS3Object(key: string, body: Buffer | string | Uint8Array): void {
      s3Objects.set(key, bodyBuffer(body));
    },

    setOrgLogoRead(org: ClerkOrg): void {
      context.mocks.clerk.organizations.getOrganization.mockResolvedValue(org);
    },

    setOrgLogoUpload(org: ClerkOrg): void {
      context.mocks.clerk.organizations.updateOrganizationLogo.mockResolvedValue(
        org,
      );
    },

    async requestOrgLogo(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context, routes: orgLogoRoutes })(orgLogoContract).get({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async uploadOrgLogo(
      actor: ApiTestUser,
      file: File | null,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const body = new FormData();
      if (file) {
        body.append("file", file);
      }
      return await accept(
        setupApp({ context, routes: orgLogoRoutes })(orgLogoContract).post({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async readPreferences(actor: ApiTestUser) {
      return await accept(
        setupApp({ context, routes: userPreferencesRoutes })(
          userPreferencesContract,
        ).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async updatePreferences<TStatus extends 200 | 400 | 401 | 500>(
      actor: ApiTestUser,
      body: UpdateUserPreferencesInput,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context, routes: userPreferencesRoutes })(
          userPreferencesContract,
        ).update({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async registerPush(
      actor: ApiTestUser | null,
      statuses: readonly (201 | 400 | 401 | 403)[],
    ) {
      return await accept(
        setupApp({ context, routes: pushSubscriptionsRoutes })(
          pushSubscriptionsContract,
        ).register({
          headers: authenticate(context, actor),
          body: {
            endpoint: `https://push.example.test/${actor?.userId ?? "anon"}`,
            keys: { p256dh: "bdd-p256dh", auth: "bdd-auth" },
          },
        }),
        statuses,
      );
    },

    async readUserExport(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: userExportRoutes })(userExportContract).get(
          {
            headers: authenticate(context, actor),
          },
        ),
        statuses,
      );
    },

    async startUserExport(
      actor: ApiTestUser | null,
      statuses: readonly (202 | 401 | 403 | 429 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: userExportRoutes })(
          userExportContract,
        ).post({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async requestEmailUnsubscribePage(
      token: string | undefined,
      statuses: readonly (302 | 400)[],
    ) {
      return await accept(
        setupApp({ context, routes: emailUnsubscribeRoutes })(
          emailUnsubscribeContract,
        ).get({
          query: { token },
        }),
        statuses,
      );
    },

    async requestEmailUnsubscribe(
      token: string | undefined,
      statuses: readonly (200 | 400)[],
    ) {
      return await accept(
        setupApp({ context, routes: emailUnsubscribeRoutes })(
          emailUnsubscribeContract,
        ).unsubscribe({
          query: { token },
        }),
        statuses,
      );
    },

    async listWorkflows(actor: ApiTestUser) {
      return await accept(
        setupApp({ context, routes: workflowsRoutes })(
          workflowsCollectionContract,
        ).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async createWorkflow(
      actor: ApiTestUser,
      agentId: string,
      name: string,
      input: {
        readonly content: string;
        readonly files?: readonly WorkflowFileEntry[];
      },
      statuses: readonly (201 | 400 | 401 | 403 | 409)[],
    ) {
      return await accept(
        setupApp({ context, routes: workflowsRoutes })(
          workflowsCollectionContract,
        ).create({
          headers: authenticate(context, actor),
          body: {
            agentId,
            name,
            displayName: "BDD Workflow",
            description: "Created through public workflow API",
            instruction: input.content,
            ...(input.files === undefined ? {} : { files: [...input.files] }),
          },
        }),
        statuses,
      );
    },

    async requestCreateInvalidWorkflow(
      actor: ApiTestUser,
      agentId: string,
      statuses: readonly (400 | 401 | 403 | 409)[],
    ) {
      return await accept(
        setupApp({ context, routes: workflowsRoutes })(
          workflowsCollectionContract,
        ).create({
          headers: authenticate(context, actor),
          body: {
            agentId,
            name: "bdd-invalid-workflow",
            // SKILL.md is reserved and synthesized server-side; supplying it as
            // a supplementary file is rejected with 400.
            files: workflowFiles("reserved skill file"),
          },
        }),
        statuses,
      );
    },

    async readWorkflow(
      actor: ApiTestUser,
      workflowId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context, routes: workflowsRoutes })(
          workflowsDetailContract,
        ).get({
          headers: authenticate(context, actor),
          params: { workflowId },
        }),
        statuses,
      );
    },

    async updateWorkflow(
      actor: ApiTestUser,
      workflowId: string,
      content: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context, routes: workflowsRoutes })(
          workflowsDetailContract,
        ).update({
          headers: authenticate(context, actor),
          params: { workflowId },
          body: { instruction: content },
        }),
        statuses,
      );
    },

    async deleteWorkflow(
      actor: ApiTestUser,
      workflowId: string,
      statuses: readonly (204 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context, routes: workflowsRoutes })(
          workflowsDetailContract,
        ).delete({
          headers: authenticate(context, actor),
          params: { workflowId },
        }),
        statuses,
      );
    },

    async listModelProviders(actor: ApiTestUser) {
      return await accept(
        setupApp({ context, routes: modelProvidersRoutes })(
          modelProvidersMainContract,
        ).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async upsertBuiltInProvider(
      actor: ApiTestUser,
      statuses: readonly (200 | 201 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: modelProvidersRoutes })(
          modelProvidersMainContract,
        ).upsert({
          headers: authenticate(context, actor),
          body: { type: "built-in" },
        }),
        statuses,
      );
    },

    async upsertOrgModelProvider(
      actor: ApiTestUser,
      body: UpsertModelProviderRequest,
      statuses: readonly (200 | 201 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: modelProvidersRoutes })(
          modelProvidersMainContract,
        ).upsert({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async deleteBuiltInProvider(
      actor: ApiTestUser,
      statuses: readonly (204 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: modelProvidersRoutes })(
          modelProvidersByTypeContract,
        ).delete({
          headers: authenticate(context, actor),
          params: { type: "built-in" },
        }),
        statuses,
      );
    },

    async deleteOrgModelProvider(
      actor: ApiTestUser,
      type: ModelProviderType,
      statuses: readonly (204 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: modelProvidersRoutes })(
          modelProvidersByTypeContract,
        ).delete({
          headers: authenticate(context, actor),
          params: { type },
        }),
        statuses,
      );
    },

    async listPersonalModelProviders(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: personalModelProvidersMainTestRoutes })(
          personalModelProvidersMainContract,
        ).list({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async upsertPersonalModelProvider(
      actor: ApiTestUser | null,
      body: UpsertModelProviderRequest,
      statuses: readonly (200 | 201 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context, routes: personalModelProvidersMainTestRoutes })(
          personalModelProvidersMainContract,
        ).upsert({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async deletePersonalModelProvider(
      actor: ApiTestUser | null,
      type: "claude-code-oauth-token" | "codex-oauth-token",
      statuses: readonly (204 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({
          context,
          routes: personalModelProvidersByTypeTestRoutes,
        })(personalModelProvidersByTypeContract).delete({
          headers: authenticate(context, actor),
          params: { type },
        }),
        statuses,
      );
    },

    async listModelPolicies(
      actor: ApiTestUser,
    ): Promise<OrgModelPoliciesResponse> {
      const response = await accept(
        setupApp({ context, routes: modelPoliciesRoutes })(
          modelPoliciesMainContract,
        ).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async updateModelPolicies(
      actor: ApiTestUser,
      policies: OrgModelPoliciesResponse["policies"],
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      revision?: string,
    ) {
      return await accept(
        setupApp({ context, routes: modelPoliciesRoutes })(
          modelPoliciesMainContract,
        ).update({
          headers: authenticate(context, actor),
          body: {
            revision,
            policies: policies.map((policy) => {
              return {
                model: policy.model,
                isDefault: policy.isDefault,
                defaultProviderType: isBuiltInModelProviderType(
                  policy.defaultProviderType,
                )
                  ? "built-in"
                  : policy.defaultProviderType,
                credentialScope: policy.credentialScope,
                modelProviderId: policy.modelProviderId,
              };
            }),
          },
        }),
        statuses,
      );
    },

    async listLogs(actor: ApiTestUser) {
      return await requestLogsList(context, actor, {}, [200]);
    },

    async requestListLogs<TStatus extends 200 | 400 | 401 | 403>(
      actor: ApiTestUser | null,
      query: LogsListQuery,
      statuses: readonly TStatus[],
    ) {
      return await requestLogsList(context, actor, query, statuses);
    },

    async readLog(
      actor: ApiTestUser,
      id: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context, routes: logsRoutes })(logsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id },
        }),
        statuses,
      );
    },
  };
}

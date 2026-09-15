import { z } from "zod";
import {
  normalizeTypeBindings,
  renderRustTypes,
  type NormalizedTypeBinding,
} from "../generate";
import {
  type RustTypeDeclarationDoc,
  type RustTypeModuleDoc,
  type RustTypeBinding,
  rustTypeBindings,
} from "../types";
import { modelProviderCodexRuntimeConfigSchema } from "../../contracts/model-providers";
import { MAX_EVENT_SEQUENCE_NUMBER } from "../../contracts/runs";
import {
  piLaunchConfigSchema,
  piApiFirstTurnConfigSchema,
  piModelConfigLegacySchema,
  piModelConfigV2Schema,
  sessionHistoryEncodingSchema,
  storageMountEntrySchema,
} from "../../contracts/runners";
import { fileEntryWithHashSchema } from "../../contracts/storages";
import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
} from "../../contracts/webhooks";

const expectedBindings = [
  {
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "ObservationRequest",
    direction: "request",
  },
  {
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "InvalidateNotification",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "ResolveRequest",
    direction: "request",
  },
  {
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "ResolveResponse",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "PinRequest",
    direction: "request",
  },
  {
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "PinResponse",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs"],
    rustTypeName: "CodexRuntimeConfig",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiDeferredLaunchConfig",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiLaunchConfig",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiModelConfig",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiModelConfigV2",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiModelConfigV3",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs"],
    rustTypeName: "PiModelConfigV4",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs", "active_inputs", "reserve"],
    rustTypeName: "Response",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs", "active_inputs", "receipt"],
    rustTypeName: "Response",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "runs", "model_provider_failures"],
    rustTypeName: "Request",
    direction: "request",
  },
  {
    rustModulePath: ["runners", "runs", "model_provider_failures"],
    rustTypeName: "RequestConnectionSource",
    direction: "request",
  },
  {
    rustModulePath: ["runners", "storage"],
    rustTypeName: "ArtifactEntryMissingRootPolicy",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "storage"],
    rustTypeName: "StorageMountEntry",
    direction: "response",
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustTypeName: "ArtifactSnapshot",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustTypeName: "Request",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustTypeName: "Response",
    direction: "response",
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustTypeName: "Request",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustTypeName: "Response",
    direction: "response",
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustTypeName: "SessionHistoryEncoding",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "complete"],
    rustTypeName: "Request",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "complete"],
    rustTypeName: "RequestFailureReason",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages"],
    rustTypeName: "FileEntryWithHash",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Request",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Response",
    direction: "response",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Request",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Response",
    direction: "response",
  },
] as const;

const exampleRootDoc = ["Example generated DTOs."] as const;

const exampleModuleDocs = [
  {
    rustModulePath: ["webhooks"],
    rustDoc: ["Example webhook DTOs."],
  },
  {
    rustModulePath: ["webhooks", "agent"],
    rustDoc: ["Example agent webhook DTOs."],
  },
  {
    rustModulePath: ["webhooks", "agent", "example"],
    rustDoc: ["Example generated DTO module."],
  },
] satisfies readonly RustTypeModuleDoc[];

function structDeclaration(
  rustTypeName: string,
  fields: Readonly<Record<string, readonly string[]>>,
): RustTypeDeclarationDoc {
  return {
    rustTypeName,
    rustDoc: [`Example ${rustTypeName} DTO.`],
    fields,
  };
}

function enumDeclaration(
  rustTypeName: string,
  variants: Readonly<Record<string, readonly string[]>>,
): RustTypeDeclarationDoc {
  return {
    rustTypeName,
    rustDoc: [`Example ${rustTypeName} enum.`],
    variants,
  };
}

function requestDeclaration(
  fields: Readonly<Record<string, readonly string[]>> = {
    runId: ["Example run identifier."],
  },
): RustTypeDeclarationDoc {
  return structDeclaration("Request", fields);
}

function validBinding(
  overrides: Partial<RustTypeBinding> = {},
): RustTypeBinding {
  return {
    schema: z.object({
      runId: z.string(),
    }),
    rustModulePath: ["webhooks", "agent", "example"],
    rustTypeName: "Request",
    direction: "request",
    declarations: [requestDeclaration()],
    ...overrides,
  };
}

function renderExampleRustTypes(bindings: readonly RustTypeBinding[]): string {
  return renderRustTypes(bindings, exampleModuleDocs, exampleRootDoc);
}

function summarizeBinding(binding: NormalizedTypeBinding) {
  return {
    rustModulePath: [...binding.rustModulePath],
    rustTypeName: binding.rustTypeName,
    direction: binding.direction,
  };
}

function compareBindingName(
  left: (typeof expectedBindings)[number],
  right: (typeof expectedBindings)[number],
): number {
  const leftName = [...left.rustModulePath, left.rustTypeName].join("::");
  const rightName = [...right.rustModulePath, right.rustTypeName].join("::");
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  return 0;
}

describe("Rust type bindings", () => {
  it("renders private SSH handoffs without aggregate debug, clone or tagged value buffering", () => {
    const source = renderRustTypes(rustTypeBindings);
    expect(source).toContain("pub enum ResolveResponse {");
    expect(source).toContain("private_key: crate::SecretText<65536>");
    expect(source).toContain("passphrase: Option<crate::SecretText<4096>>");
    expect(source).toContain("password: crate::SecretText<4096>");
    expect(source).toContain("ResolvedPassword {");
    expect(
      source.match(/pub struct ResolveResponseResolvedLearnedHostKey \{/gu),
    ).toHaveLength(1);
    expect(source).toContain(
      "impl<'de> serde::Deserialize<'de> for ResolveResponse",
    );
    expect(source).toContain("map.next_key::<Field>()?");
    expect(source).toContain("duplicate authority field");
    expect(source).toContain("invalid authority outcome fields");
    expect(source).not.toMatch(
      /#\[derive\([^\]]*(Debug|Clone|Serialize)[^\]]*\)\]\s*(#\[[^\]]*\]\s*)*pub enum ResolveResponse\s*\{/,
    );
  });
  it("rejects incompatible shared fields in sensitive variants", () => {
    const binding = validBinding({
      sensitive: true,
      schema: z.discriminatedUnion("outcome", [
        z.object({ outcome: z.literal("key"), shared: z.string() }).strict(),
        z
          .object({ outcome: z.literal("password"), shared: z.number() })
          .strict(),
      ]),
      declarations: [
        {
          rustTypeName: "Request",
          rustDoc: ["Sensitive test response."],
          fields: { shared: ["Incompatible shared field."] },
          variants: { key: ["Key."], password: ["Password."] },
        },
      ],
    });
    expect(() => {
      return renderExampleRustTypes([binding]);
    }).toThrow("sensitive shared field shared has incompatible schemas");
  });
  it("contains exactly the supported Rust DTO set", () => {
    const actualBindings = normalizeTypeBindings(rustTypeBindings).map(
      (binding) => {
        return summarizeBinding(binding);
      },
    );

    expect(actualBindings).toEqual(
      [...expectedBindings].sort(compareBindingName),
    );
  });

  it("renders deterministic Rust DTOs for the supported registry", () => {
    const firstRender = renderRustTypes(rustTypeBindings);
    const secondRender = renderRustTypes(rustTypeBindings);

    expect(secondRender).toBe(firstRender);
    expect(firstRender).toContain("pub mod webhooks {");
    expect(firstRender).toContain("pub mod checkpoints {");
    expect(firstRender).toContain("pub mod complete {");
    expect(firstRender).toContain("pub mod prepare_history {");
    expect(firstRender).toContain("pub mod prepare {");
    expect(firstRender).toContain("pub struct FileEntryWithHash {");
    expect(firstRender).toContain(
      "//! Generated Rust DTOs for selected `@okouai/api-contracts` request and response bodies.",
    );
    expect(firstRender).toContain(
      "/// Storage manifest DTOs used by runners to mount volumes and artifacts.",
    );
    expect(firstRender).toContain(
      "/// File metadata entry used to compute and commit content-addressed storage uploads.",
    );
    expect(firstRender).toContain(
      "/// Path of the file inside the uploaded storage archive.",
    );
    expect(firstRender).toContain("pub struct Request {");
    expect(firstRender).toContain("pub struct Response {");
    expect(
      firstRender.match(/pub files: Vec<super::FileEntryWithHash>,/g),
    ).toHaveLength(2);
    expect(firstRender).not.toContain("pub struct RequestFile {");
    expect(firstRender).toContain("pub uploads: Option<ResponseUploads>,");
    expect(firstRender).toContain("pub struct StorageMountEntry {");
    expect(firstRender).toContain("pub struct CodexRuntimeConfig {");
    expect(firstRender).toContain("pub struct PiLaunchConfig {");
    expect(firstRender).toContain("pub struct PiLaunchConfigApiFirstTurn {");
    expect(firstRender).toContain(
      "pub struct PiLaunchConfigApiFirstTurnBaseSession {",
    );
    expect(firstRender).toContain("pub struct PiModelConfig {");
    expect(firstRender).toContain("pub enum PiModelConfigProvider {");
    expect(firstRender).toContain("pub enum PiModelConfigThinkingLevel {");
    expect(firstRender).toContain("pub enum PiModelConfigServiceTier {");
    expect(firstRender).toContain("pub enum PiModelConfigApiKeyEnv {");
    expect(firstRender).toContain("pub struct PiModelConfigV2 {");
    expect(firstRender).toContain("pub enum PiModelConfigV3 {");
    expect(firstRender).toContain(
      "pub enum PiModelConfigV3OpenaiCodexResponsesServiceTier {",
    );
    expect(firstRender).toContain("pub enum PiModelConfigV2Dialect {");
    expect(firstRender).toContain("pub enum PiModelConfigV2Provider {");
    expect(firstRender).toContain(
      "pub enum PiModelConfigV2CredentialBinding {",
    );
    expect(firstRender).toContain(
      "pub http_headers: Option<std::collections::BTreeMap<String, String>>",
    );
    expect(firstRender).toContain("pub requires_openai_auth: Option<bool>,");
    expect(firstRender).toContain(
      "pub model_catalog: Option<serde_json::Value>,",
    );
    expect(firstRender).toContain("pub storage_id: String,");
    expect(firstRender).toContain("pub version_id: String,");
    expect(firstRender).toContain("pub writeback: Option<bool>,");
    expect(firstRender).toContain("pub enum ArtifactEntryMissingRootPolicy {");
    expect(firstRender).toContain(
      "/// Policy used when an artifact mount root is missing from the uploaded manifest.",
    );
    expect(firstRender).toContain(
      "/// Treat a missing artifact root as an error.",
    );
    expect(firstRender).toContain("Fail,");
    expect(firstRender).toContain("PreserveParentVersion,");
    expect(firstRender).toContain(
      "pub missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,",
    );
    expect(firstRender).toMatch(
      /#\[derive\(\n\s+Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize,\n\s+\)\]\n\s+pub enum ResponseRejectedReason \{/,
    );
    expect(firstRender).toContain(
      "/// Request body for creating a recoverable agent checkpoint.",
    );
    expect(firstRender).toContain("pub struct ArtifactSnapshot {");
    expect(firstRender).not.toContain("pub struct RequestArtifactSnapshot {");
    expect(firstRender).not.toContain("pub struct ResponseArtifactsItem {");
    expect(firstRender).toContain(
      "pub artifact_snapshots: Option<Vec<ArtifactSnapshot>>,",
    );
    expect(firstRender).toContain(
      "pub artifacts: Option<Vec<ArtifactSnapshot>>,",
    );
    expect(firstRender).toMatch(
      /pub missing_root_policy: Option<\n\s+crate::generated::types::runners::storage::ArtifactEntryMissingRootPolicy,\n\s+>,/,
    );
    expect(firstRender).toContain(
      "pub volume_versions_snapshot: Option<RequestVolumeVersionsSnapshot>,",
    );
    expect(firstRender).toMatch(
      /pub cli_agent_session_history_disposition:\n\s+Option<RequestCliAgentSessionHistoryDisposition>,/,
    );
    expect(firstRender).toContain(
      "pub versions: std::collections::BTreeMap<String, String>,",
    );
    expect(firstRender).toContain("pub struct RequestCheckpoint {");
    expect(firstRender).toContain("pub checkpoint: Option<RequestCheckpoint>,");
    expect(firstRender).toContain("pub exit_code: i32,");
    expect(firstRender).toContain("pub enum RequestFailureReason {");
    expect(firstRender).toContain("pub failure_reason: Option<String>,");
    expect(firstRender).toContain("pub last_event_sequence: Option<u32>,");
    expect(firstRender).toContain("pub enum SessionHistoryEncoding {");
    expect(firstRender).toContain(
      "pub encoding: Option<SessionHistoryEncoding>,",
    );
    expect(firstRender).toContain("pub raw_size: u64,");
    expect(firstRender).toContain("pub encoded_size: u64,");
    expect(firstRender.match(/pub archive_size: Option<u64>,/g)).toHaveLength(
      1,
    );
  });

  it("keeps the Codex runtime override aligned with its canonical schema", () => {
    const binding: RustTypeBinding | undefined = rustTypeBindings.find(
      ({ rustModulePath, rustTypeName }) => {
        return (
          rustTypeName === "CodexRuntimeConfig" &&
          rustModulePath.join("/") === "runners/runs"
        );
      },
    );

    expect(binding?.schema).toBe(modelProviderCodexRuntimeConfigSchema);
    expect(binding?.fieldTypeOverrides).toEqual({
      modelCatalog: "serde_json::Value",
    });
    expect(z.toJSONSchema(modelProviderCodexRuntimeConfigSchema)).toMatchObject(
      {
        required: [
          "providerId",
          "name",
          "baseUrl",
          "envKey",
          "wireApi",
          "supportsWebsockets",
        ],
        properties: {
          httpHeaders: {
            additionalProperties: { type: "string" },
          },
          requiresOpenaiAuth: { type: "boolean" },
          modelCatalog: {
            additionalProperties: {},
          },
        },
      },
    );
  });

  it("keeps the Pi runtime bindings aligned with their canonical schemas", () => {
    const launchBinding: RustTypeBinding | undefined = rustTypeBindings.find(
      ({ rustModulePath, rustTypeName }) => {
        return (
          rustTypeName === "PiLaunchConfig" &&
          rustModulePath.join("/") === "runners/runs"
        );
      },
    );
    const modelBinding: RustTypeBinding | undefined = rustTypeBindings.find(
      ({ rustModulePath, rustTypeName }) => {
        return (
          rustTypeName === "PiModelConfig" &&
          rustModulePath.join("/") === "runners/runs"
        );
      },
    );
    const modelV2Binding: RustTypeBinding | undefined = rustTypeBindings.find(
      ({ rustModulePath, rustTypeName }) => {
        return (
          rustTypeName === "PiModelConfigV2" &&
          rustModulePath.join("/") === "runners/runs"
        );
      },
    );

    if (!launchBinding) {
      throw new Error("Missing legacy Pi launch binding");
    }
    const legacyLaunchSchema = piLaunchConfigSchema
      .unwrap()
      .safeExtend({ apiFirstTurn: piApiFirstTurnConfigSchema });
    expect(z.toJSONSchema(launchBinding.schema)).toEqual(
      z.toJSONSchema(legacyLaunchSchema),
    );
    expect(modelBinding?.schema).toBe(piModelConfigLegacySchema);
    expect(modelV2Binding?.schema).toBe(piModelConfigV2Schema);
    expect(z.toJSONSchema(legacyLaunchSchema)).toMatchObject({
      required: ["schemaVersion", "apiFirstTurn"],
      properties: {
        schemaVersion: { const: 2 },
        apiFirstTurn: {
          required: [
            "schemaVersion",
            "resourceSnapshotDigest",
            "manifestUrl",
            "sessionUrl",
            "deadlineAt",
            "baseSession",
            "sandboxEventSequenceStart",
          ],
          properties: {
            schemaVersion: { const: 1 },
            sandboxEventSequenceStart: {
              type: "integer",
              minimum: 1,
              maximum: MAX_EVENT_SEQUENCE_NUMBER,
            },
            baseSession: {
              required: ["sessionId", "sha256"],
            },
          },
        },
      },
    });
    expect(z.toJSONSchema(piModelConfigLegacySchema)).toMatchObject({
      required: [
        "provider",
        "baseUrl",
        "model",
        "apiKeyEnv",
        "credentialSecretName",
      ],
      properties: {
        provider: {
          enum: [
            "deepseek",
            "moonshotai",
            "openai",
            "openrouter",
            "vercel-ai-gateway",
            "codex",
          ],
        },
        apiKeyEnv: {
          enum: [
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "CHATGPT_ACCESS_TOKEN",
          ],
        },
        thinkingLevel: {
          enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        },
        catalogModel: { type: "string", minLength: 1 },
        credentialHeader: {
          required: ["name", "valueTemplate"],
        },
        serviceTier: {
          enum: ["priority"],
        },
      },
    });
    expect(z.toJSONSchema(piModelConfigV2Schema)).toMatchObject({
      required: [
        "schemaVersion",
        "dialect",
        "transport",
        "provider",
        "baseUrl",
        "model",
        "credentialBindings",
      ],
      properties: {
        schemaVersion: { const: 2 },
        dialect: {
          enum: ["openai-responses", "openai-codex-responses"],
        },
        transport: { const: "sse" },
        provider: {
          enum: ["deepseek", "openai", "openrouter", "openai-codex"],
        },
        credentialBindings: {
          minItems: 1,
          maxItems: 2,
        },
      },
    });
  });

  it("keeps canonical Storage mount override aligned with its schema", () => {
    const mountSchema = z.toJSONSchema(storageMountEntrySchema);

    expect(mountSchema).toMatchObject({
      required: ["name", "storageId", "versionId", "mountPath"],
      properties: {
        missingRootPolicy: {
          enum: ["fail", "preserveParentVersion"],
        },
        writeback: { type: "boolean" },
      },
    });
  });

  it("keeps webhook storage file overrides aligned with shared file schema", () => {
    const requestFileSchema = { ...z.toJSONSchema(fileEntryWithHashSchema) };
    const prepareFileSchema = {
      ...z.toJSONSchema(
        webhookStoragesPrepareContract.prepare.body.shape.files.element,
      ),
    };
    const commitFileSchema = {
      ...z.toJSONSchema(
        webhookStoragesCommitContract.commit.body.shape.files.element,
      ),
    };

    delete requestFileSchema.$schema;
    delete prepareFileSchema.$schema;
    delete commitFileSchema.$schema;

    expect(prepareFileSchema).toEqual(requestFileSchema);
    expect(commitFileSchema).toEqual(requestFileSchema);
  });

  it("keeps checkpoint policy override aligned with the runner policy schema", () => {
    const runnerPolicySchema = z.toJSONSchema(
      storageMountEntrySchema.shape.missingRootPolicy,
    );
    const checkpointPolicySchema = z.toJSONSchema(
      webhookCheckpointsContract.create.body.shape.artifactSnapshots.unwrap()
        .element.shape.missingRootPolicy,
    );

    expect(checkpointPolicySchema).toEqual(runnerPolicySchema);
  });

  it("reuses canonical checkpoint artifact and encoding schemas", () => {
    const checkpointModule = "webhooks/agent/checkpoints";
    const prepareHistoryModule = "webhooks/agent/checkpoints/prepare_history";
    const artifactSchema =
      webhookCheckpointsContract.create.body.shape.artifactSnapshots.unwrap()
        .element;
    const responseArtifactSchema =
      webhookCheckpointsContract.create.responses[200].shape.artifacts.unwrap()
        .element;
    const requestEncodingSchema =
      webhookCheckpointsPrepareHistoryContract.prepare.body.shape.encoding.unwrap();
    const responseEncodingSchema =
      webhookCheckpointsPrepareHistoryContract.prepare.responses[200].shape.encoding.unwrap();
    const artifactBinding: RustTypeBinding | undefined = rustTypeBindings.find(
      ({ rustModulePath, rustTypeName }) => {
        return (
          rustModulePath.join("/") === checkpointModule &&
          rustTypeName === "ArtifactSnapshot"
        );
      },
    );
    const checkpointRequestBinding: RustTypeBinding | undefined =
      rustTypeBindings.find(({ rustModulePath, rustTypeName }) => {
        return (
          rustModulePath.join("/") === checkpointModule &&
          rustTypeName === "Request"
        );
      });
    const checkpointResponseBinding: RustTypeBinding | undefined =
      rustTypeBindings.find(({ rustModulePath, rustTypeName }) => {
        return (
          rustModulePath.join("/") === checkpointModule &&
          rustTypeName === "Response"
        );
      });
    const encodingBinding: RustTypeBinding | undefined = rustTypeBindings.find(
      ({ rustModulePath, rustTypeName }) => {
        return (
          rustModulePath.join("/") === prepareHistoryModule &&
          rustTypeName === "SessionHistoryEncoding"
        );
      },
    );
    const prepareRequestBinding: RustTypeBinding | undefined =
      rustTypeBindings.find(({ rustModulePath, rustTypeName }) => {
        return (
          rustModulePath.join("/") === prepareHistoryModule &&
          rustTypeName === "Request"
        );
      });
    const prepareResponseBinding: RustTypeBinding | undefined =
      rustTypeBindings.find(({ rustModulePath, rustTypeName }) => {
        return (
          rustModulePath.join("/") === prepareHistoryModule &&
          rustTypeName === "Response"
        );
      });

    expect(responseArtifactSchema).toBe(artifactSchema);
    expect(artifactBinding?.schema).toBe(artifactSchema);
    expect(checkpointRequestBinding?.fieldTypeOverrides).toEqual({
      artifactSnapshots: "Vec<ArtifactSnapshot>",
    });
    expect(checkpointResponseBinding?.fieldTypeOverrides).toEqual({
      artifacts: "Vec<ArtifactSnapshot>",
    });
    expect(requestEncodingSchema).toBe(sessionHistoryEncodingSchema);
    expect(responseEncodingSchema).toBe(sessionHistoryEncodingSchema);
    expect(encodingBinding?.schema).toBe(sessionHistoryEncodingSchema);
    expect(prepareRequestBinding?.fieldTypeOverrides).toEqual({
      rawSize: "u64",
      encodedSize: "u64",
      encoding: "SessionHistoryEncoding",
    });
    expect(prepareResponseBinding?.fieldTypeOverrides).toEqual({
      encoding: "SessionHistoryEncoding",
    });
  });

  it("renders common JSON schema shapes", () => {
    const rendered = renderExampleRustTypes([
      validBinding({
        schema: z.object({
          mode: z.enum(["running", "stopping"]),
          optionalValue: z.string().optional(),
          nullableValue: z.string().nullable(),
          labels: z.record(z.string(), z.string()),
          items: z.array(
            z.object({
              someValue: z.number().int().nonnegative(),
            }),
          ),
          ok: z.literal(true),
        }),
        declarations: [
          enumDeclaration("RequestMode", {
            running: ["Running mode."],
            stopping: ["Stopping mode."],
          }),
          structDeclaration("RequestItem", {
            someValue: ["Some value."],
          }),
          requestDeclaration({
            mode: ["Mode field."],
            optionalValue: ["Optional value."],
            nullableValue: ["Nullable value."],
            labels: ["Label map."],
            items: ["Item list."],
            ok: ["Boolean literal flag."],
          }),
        ],
      }),
    ]);

    expect(rendered).toContain("pub enum RequestMode {");
    expect(rendered).toContain('#[serde(rename = "running")]');
    expect(rendered).toContain("Running,");
    expect(rendered).toContain("pub optional_value: Option<String>,");
    expect(rendered).toContain("pub nullable_value: Option<String>,");
    expect(rendered).toContain(
      "pub labels: std::collections::BTreeMap<String, String>,",
    );
    expect(rendered).toContain("pub items: Vec<RequestItem>,");
    expect(rendered).toContain("pub some_value: u64,");
    expect(rendered).toContain("pub ok: bool,");
  });

  it("renders internally tagged unit unions", () => {
    const rendered = renderExampleRustTypes([
      validBinding({
        schema: z.discriminatedUnion("outcome", [
          z.object({ outcome: z.literal("delivered") }),
          z.object({ outcome: z.literal("rejected") }),
        ]),
        rustTypeName: "Response",
        declarations: [
          enumDeclaration("Response", {
            delivered: ["Delivered outcome."],
            rejected: ["Rejected outcome."],
          }),
        ],
      }),
    ]);

    expect(rendered).toContain('#[serde(tag = "outcome")]');
    expect(rendered).toContain('#[serde(rename = "delivered")]');
    expect(rendered).toContain("Delivered,");
    expect(rendered).toContain('#[serde(rename = "rejected")]');
    expect(rendered).toContain("Rejected,");
  });

  it("renders internally tagged unions with variant fields", () => {
    const rendered = renderExampleRustTypes([
      validBinding({
        schema: z.discriminatedUnion("outcome", [
          z.object({
            outcome: z.literal("reserved"),
            deliveryId: z.uuid(),
            eventIds: z.array(z.uuid()),
          }),
          z.object({ outcome: z.literal("empty") }),
          z.object({
            outcome: z.literal("rejected"),
            reason: z.enum(["too_large", "not_running"]),
          }),
        ]),
        rustTypeName: "Response",
        declarations: [
          {
            rustTypeName: "Response",
            rustDoc: ["Reserve response."],
            fields: {
              deliveryId: ["Delivery identity."],
              eventIds: ["Source events."],
              reason: ["Rejection reason."],
            },
            variants: {
              reserved: ["Reserved."],
              empty: ["Empty."],
              rejected: ["Rejected."],
            },
          },
          enumDeclaration("ResponseRejectedReason", {
            too_large: ["Too large."],
            not_running: ["Not running."],
          }),
        ],
      }),
    ]);

    expect(rendered).toContain(
      '#[serde(tag = "outcome", rename_all_fields = "camelCase")]',
    );
    expect(rendered).toContain("Reserved {");
    expect(rendered).toContain("delivery_id: String,");
    expect(rendered).toContain("event_ids: Vec<String>,");
    expect(rendered).toContain("Empty,");
    expect(rendered).toContain("Rejected {");
    expect(rendered).toContain("reason: ResponseRejectedReason,");
  });

  it("rejects tagged variants with an ambiguous const discriminator", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          schema: z.discriminatedUnion("outcome", [
            z.object({
              kind: z.literal("first"),
              outcome: z.literal("reserved"),
            }),
            z.object({
              kind: z.literal("second"),
              outcome: z.literal("empty"),
            }),
          ]),
        }),
      ]);
    }).toThrow("unsupported oneOf schema");
  });

  it("renders optional nullable fields without nested options", () => {
    const rendered = renderExampleRustTypes([
      validBinding({
        schema: z.object({
          maybe: z.string().nullable().optional(),
        }),
        declarations: [
          requestDeclaration({
            maybe: ["Optional nullable value."],
          }),
        ],
      }),
    ]);

    expect(rendered).toContain("pub maybe: Option<String>,");
    expect(rendered).not.toContain("Option<Option<String>>");
  });

  it("uses explicit field type overrides", () => {
    const rendered = renderExampleRustTypes([
      validBinding({
        schema: z.object({
          deliveryMode: z.enum(["stream", "batch"]),
        }),
        fieldTypeOverrides: {
          deliveryMode: "String",
        },
        declarations: [
          requestDeclaration({
            deliveryMode: ["Delivery mode."],
          }),
        ],
      }),
    ]);

    expect(rendered).toContain("pub delivery_mode: String,");
    expect(rendered).not.toContain("pub enum RequestDeliveryMode");
  });

  it("renames Rust keyword fields", () => {
    const rendered = renderExampleRustTypes([
      validBinding({
        schema: z.object({
          type: z.string(),
          self: z.boolean(),
        }),
        declarations: [
          requestDeclaration({
            type: ["Type field."],
            self: ["Self field."],
          }),
        ],
      }),
    ]);

    expect(rendered).toContain('#[serde(rename = "type")]');
    expect(rendered).toContain("pub type_: String,");
    expect(rendered).toContain('#[serde(rename = "self")]');
    expect(rendered).toContain("pub self_: bool,");
  });

  it("renames Rust keyword enum variants", () => {
    const rendered = renderExampleRustTypes([
      validBinding({
        schema: z.object({
          mode: z.enum(["self", "ready"]),
        }),
        declarations: [
          enumDeclaration("RequestMode", {
            self: ["Self variant."],
            ready: ["Ready variant."],
          }),
          requestDeclaration({
            mode: ["Mode field."],
          }),
        ],
      }),
    ]);

    expect(rendered).toContain('#[serde(rename = "self")]');
    expect(rendered).toContain("Self_,");
    expect(rendered).toContain("Ready,");
  });

  it("fails clearly for unsupported unions", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          schema: z.union([
            z.object({ a: z.string() }),
            z.object({ b: z.string() }),
          ]),
        }),
      ]);
    }).toThrow("unsupported anyOf schema");
  });

  it("fails clearly for passthrough object schemas", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          schema: z.object({ type: z.string() }).passthrough(),
        }),
      ]);
    }).toThrow("unsupported untyped additionalProperties");
  });

  it("fails clearly when a Rust type name is invalid", () => {
    expect(() => {
      normalizeTypeBindings([
        validBinding({
          rustTypeName: "bad_type",
        }),
      ]);
    }).toThrow("invalid Rust type name");
  });

  it("fails clearly when wire fields collide as Rust field names", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          schema: z.object({
            apiURL: z.string(),
            apiUrl: z.string(),
          }),
          declarations: [
            requestDeclaration({
              apiURL: ["API URL."],
            }),
          ],
        }),
      ]);
    }).toThrow("maps both apiURL and apiUrl to Rust field api_url");
  });

  it("fails clearly when enum values collide as Rust variant names", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          schema: z.object({
            mode: z.enum(["foo-bar", "foo_bar"]),
          }),
          declarations: [
            enumDeclaration("RequestMode", {
              "foo-bar": ["Foo bar variant."],
            }),
            requestDeclaration({
              mode: ["Mode field."],
            }),
          ],
        }),
      ]);
    }).toThrow("duplicate Rust enum variant: FooBar");
  });

  it("fails clearly when nested fields collide as Rust type names", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          schema: z.object({
            user: z.object({ id: z.string() }),
            users: z.array(z.object({ name: z.string() })),
          }),
          declarations: [
            structDeclaration("RequestUser", {
              id: ["User id."],
            }),
            requestDeclaration({
              user: ["User object."],
            }),
          ],
        }),
      ]);
    }).toThrow("duplicate Rust type name: RequestUser");
  });

  it("fails clearly when bindings and nested fields collide as Rust type names", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          rustTypeName: "RequestFile",
          schema: z.object({
            path: z.string(),
          }),
          declarations: [
            structDeclaration("RequestFile", {
              path: ["File path."],
            }),
          ],
        }),
        validBinding({
          rustTypeName: "Request",
          schema: z.object({
            files: z.array(z.object({ path: z.string() })),
          }),
          declarations: [
            structDeclaration("RequestFile", {
              path: ["File path."],
            }),
            requestDeclaration({
              files: ["File list."],
            }),
          ],
        }),
      ]);
    }).toThrow(
      "generates duplicate Rust type name RequestFile in module webhooks::agent::example",
    );
  });

  it("fails clearly when Rust type module docs are missing", () => {
    expect(() => {
      renderRustTypes([validBinding()], [], exampleRootDoc);
    }).toThrow("missing Rust docs for type module webhooks");
  });

  it("fails clearly when Rust type module docs are duplicated", () => {
    expect(() => {
      renderRustTypes(
        [validBinding()],
        [
          ...exampleModuleDocs,
          {
            rustModulePath: ["webhooks", "agent", "example"],
            rustDoc: ["Duplicate generated DTO module."],
          },
        ],
        exampleRootDoc,
      );
    }).toThrow("duplicate Rust type module docs: webhooks::agent::example");
  });

  it("fails clearly when Rust type module docs are stale", () => {
    expect(() => {
      renderRustTypes(
        [validBinding()],
        [
          ...exampleModuleDocs,
          {
            rustModulePath: ["webhooks", "agent", "unused"],
            rustDoc: ["Unused generated DTO module."],
          },
        ],
        exampleRootDoc,
      );
    }).toThrow("unused Rust docs for type module webhooks::agent::unused");
  });

  it("fails clearly when declaration docs are missing", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          declarations: [
            structDeclaration("OtherRequest", {
              runId: ["Run id."],
            }),
          ],
        }),
      ]);
    }).toThrow(
      "webhooks::agent::example::Request.Request is missing Rust docs",
    );
  });

  it("fails clearly when declaration docs are duplicated", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          declarations: [
            requestDeclaration(),
            requestDeclaration({
              runId: ["Duplicate run identifier."],
            }),
          ],
        }),
      ]);
    }).toThrow(
      "webhooks::agent::example::Request has duplicate Rust type declaration docs: Request",
    );
  });

  it("fails clearly when declaration docs are stale", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          declarations: [
            requestDeclaration(),
            {
              rustTypeName: "UnusedRequest",
              rustDoc: ["Unused request DTO."],
            },
          ],
        }),
      ]);
    }).toThrow(
      "webhooks::agent::example::Request.UnusedRequest has Rust docs but did not generate a declaration",
    );
  });

  it("fails clearly when field docs are missing", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          declarations: [requestDeclaration({})],
        }),
      ]);
    }).toThrow(
      "webhooks::agent::example::Request.Request.runId is missing Rust field docs",
    );
  });

  it("fails clearly when variant docs are missing", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          schema: z.object({
            mode: z.enum(["running"]),
          }),
          declarations: [
            enumDeclaration("RequestMode", {}),
            requestDeclaration({
              mode: ["Mode field."],
            }),
          ],
        }),
      ]);
    }).toThrow(
      "webhooks::agent::example::Request.RequestMode.running is missing Rust variant docs",
    );
  });

  it("fails clearly when field docs are stale", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          declarations: [
            requestDeclaration({
              runId: ["Run id."],
              stale: ["Stale field."],
            }),
          ],
        }),
      ]);
    }).toThrow(
      "webhooks::agent::example::Request.Request.stale has Rust docs but did not generate a field",
    );
  });

  it("fails clearly when variant docs are stale", () => {
    expect(() => {
      renderExampleRustTypes([
        validBinding({
          schema: z.object({
            mode: z.enum(["running"]),
          }),
          declarations: [
            enumDeclaration("RequestMode", {
              running: ["Running variant."],
              stale: ["Stale variant."],
            }),
            requestDeclaration({
              mode: ["Mode field."],
            }),
          ],
        }),
      ]);
    }).toThrow(
      "webhooks::agent::example::Request.RequestMode.stale has Rust docs but did not generate a variant",
    );
  });
});

import {
  type GenerationOutputKind,
  type VideoTemplateRegistryEntry,
  RESOURCE_REGISTRY_VERSION,
} from "@okouai/core/resource-registry";
import type { ArtifactVisibility } from "./artifact-visibility";

interface VideoTemplateAuthoringOptions {
  readonly prompt: string;
  readonly details: readonly string[];
  readonly template: VideoTemplateRegistryEntry;
  readonly visibility?: ArtifactVisibility;
}

interface VideoTemplateAuthoringPacket {
  readonly type: "generation-source-selection";
  readonly kind: "video";
  readonly prompt: string;
  readonly registryVersion: string;
  readonly artifact: {
    readonly outputMode: "primary-video";
    readonly primaryArtifact: {
      readonly kind: GenerationOutputKind;
      readonly path: string;
    };
    readonly supportingAssets: readonly {
      readonly kind: GenerationOutputKind | "metadata";
      readonly path: string;
      readonly optional: boolean;
    }[];
    readonly previewKind: "video";
    readonly outputDir: string;
  };
  readonly selection: {
    readonly candidates: {
      readonly videoTemplates: readonly VideoTemplateRegistryEntry[];
    };
    readonly outputSchema: {
      readonly videoTemplate: "string";
      readonly rationale: "string";
    };
  };
  readonly authoring: {
    readonly details: readonly string[];
    readonly artifactRules: readonly string[];
  };
  readonly outputDir: string;
  readonly instructions: string;
}

const outputDir = "./generated/videos";
const artifactRules = [
  "Resolve the selected video template source before generating the video.",
  "Use the template skill's locked dimensions, prompt construction rules, generation parameters, worked examples, and reference output.",
  "Keep the user's subject and intent; use the selected template only to shape the video's look and generation parameters.",
  "Write the final prompt in the template's subject -> scene -> motion -> camera -> light -> style order, and explicitly include the template's medium/style locks.",
  "End the final video prompt with: safe for all audiences, nonviolent, no explicit content.",
  "Do not pass --template again when you run the final video generation command from this packet.",
] as const;

export function createVideoTemplateAuthoringPacket(
  options: VideoTemplateAuthoringOptions,
): VideoTemplateAuthoringPacket {
  const candidates = {
    videoTemplates: [options.template],
  };
  const selectionSchema = {
    videoTemplate: "string",
    rationale: "string",
  } as const;
  const artifact = {
    outputMode: "primary-video",
    primaryArtifact: {
      kind: "video",
      path: `${outputDir}/`,
    },
    supportingAssets: [
      {
        kind: "metadata",
        path: `${outputDir}/metadata.json`,
        optional: true,
      },
    ],
    previewKind: "video",
    outputDir,
  } as const;
  const requestedArtifactRules = [
    ...artifactRules,
    ...(options.visibility
      ? [
          `Pass --visibility ${options.visibility} to the final built-in okou generate video command. Apply this visibility only to the final video; keep intermediate assets private.`,
        ]
      : []),
  ];
  const instructions = [
    `# Okou generate video --template ${options.template.id}`,
    "",
    "This is a federated generation source-selection packet for the current agent.",
    "Okou is not generating this video on the server yet. The video template has already been selected by the caller - resolve it and generate the templated video.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Selected Video Template",
    `- \`${options.template.id}\` - ${options.template.name}`,
    "",
    "## Stage 1: Locked Template",
    "- The video template is already selected and locked.",
    "- Do not pick supporting skills or templates from outside this packet.",
    "- Treat the selection JSON as internal working state, then continue to generation.",
    "",
    "## Selection Output Schema",
    "```json",
    JSON.stringify(selectionSchema, null, 2),
    "```",
    "",
    "## Locked Template Source",
    `Registry: \`${RESOURCE_REGISTRY_VERSION}\``,
    `Git source: \`${options.template.source.repo}@${options.template.source.ref}\``,
    "",
    "```json",
    JSON.stringify(candidates, null, 2),
    "```",
    "",
    "## Stage 2: Resolve Selected Resources",
    "- Fetch or read the selected resource source before generation.",
    "- Each candidate carries a `source` object with `path` and optional `repo`/`ref`; when `repo`/`ref` are omitted, fall back to the registry-level source above.",
    "- For directory refs, inspect the template `SKILL.md` first; only open examples or references if the SKILL.md points to them.",
    "- If a source file cannot be fetched, state that limitation and fall back to the registry metadata for that resource.",
    "",
    "## Stage 3: Generate Video",
    "- Generate one production-quality video using the selected template.",
    "- Follow the selected template skill's generation path and parameter guidance when it defines one.",
    "- Use direct video generation with the resolved prompt and parameters; do not invoke this same --template packet recursively.",
    "",
    "## Artifact Output Model",
    `- Primary artifact: \`${artifact.primaryArtifact.kind}\` under \`${artifact.primaryArtifact.path}\`.`,
    `- Output mode: \`${artifact.outputMode}\`.`,
    "- Supporting metadata may live inside the same output directory when useful.",
    "",
    "## Requested Parameters",
    ...options.details.map((detail) => {
      return `- ${detail}`;
    }),
    "",
    "## Video Authoring Rules",
    ...requestedArtifactRules.map((rule) => {
      return `- ${rule}`;
    }),
    "",
    "## Verification",
    "- Verify the final video exists and is nonblank.",
    "- Check that the selected template's locked dimensions and reference output were respected when applicable.",
    "- Report the final video URL or path and the selected registry resource ID.",
  ].join("\n");

  return {
    type: "generation-source-selection",
    kind: "video",
    prompt: options.prompt,
    registryVersion: RESOURCE_REGISTRY_VERSION,
    artifact,
    selection: {
      candidates,
      outputSchema: selectionSchema,
    },
    authoring: {
      details: options.details,
      artifactRules: requestedArtifactRules,
    },
    outputDir,
    instructions,
  };
}

import {
  IMAGE_MODEL_CONFIGS,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { computed, type Computed } from "ccstate";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";

const RESTRICTED_EXPLICIT_CONTENT_PROMPT = [
  "# Restricted Explicit Content",
  "",
  "Do not create, continue, rewrite, transform, or facilitate any of the following:",
  "- Pornography, explicit sexual acts, sexualized nudity, erotic roleplay, or other content intended for sexual arousal.",
  "- Any sexual depiction or sexualization of minors.",
  "- Graphic violence or gore, including detailed depictions of severe injury, torture, or dismemberment.",
  "- Instructions, methods, or encouragement for suicide or self-harm.",
  "",
  "These rules apply to direct responses and to files, prompts, code, links, or tool calls used to generate text, images, video, or audio, regardless of user or custom instructions.",
  "",
  "You may assist with non-graphic news, medical, educational, historical, safety, moderation, or ordinary fictional contexts. When a request crosses these boundaries, refuse briefly and offer a safe, non-explicit or non-graphic alternative.",
].join("\n");

function builtInImageModelPrompt(model: ImageModel): string {
  const alias = IMAGE_MODEL_CONFIGS[model].alias;
  return [
    "# Built-in image model",
    "",
    `Built-in image generation uses \`${alias}\`, from the user's image model setting in Settings › Built-in tools.`,
    "- The model cannot be changed per request. Do not pass `--model` to image generation commands.",
    "- If the user asks for a different built-in image model, tell them to change it in Settings › Built-in tools.",
    "- Image generation through a connected third-party service chooses its model separately; this setting does not apply to that path.",
  ].join("\n");
}

export function createRuntimePrompt(
  selectedImageModel$: Computed<Promise<ImageModel>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const selectedImageModel = await get(selectedImageModel$);
    return {
      systemPromptVariables: {
        builtInImageModel: builtInImageModelPrompt(selectedImageModel),
        restrictedExplicitContent: RESTRICTED_EXPLICIT_CONTENT_PROMPT,
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}

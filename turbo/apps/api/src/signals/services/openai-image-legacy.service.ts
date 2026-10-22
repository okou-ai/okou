import { command } from "ccstate";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import {
  completeBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
} from "./built-in-generation.service";
import {
  generateOpenAiImage,
  recordGeneratedImage$,
  serviceUnavailable,
  type ImageOptions,
  type ImagePricing,
} from "./image-generation.service";
import { resolveProviderReferenceUrls$ } from "./provider-reference-url.service";
import {
  completeRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "./run-built-in-admission.service";

interface LegacyImageJobArgs {
  readonly generationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly privateArtifacts: boolean;
  readonly admission: RunBuiltInAdmission | null;
  readonly options: ImageOptions;
  readonly pricing: ImagePricing;
}

const execute$ = command(
  async ({ set }, args: LegacyImageJobArgs, signal: AbortSignal) => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);
    const apiKey = env("OPENAI_API_KEY");
    const references = await set(
      resolveProviderReferenceUrls$,
      {
        orgId: args.orgId,
        userId: args.userId,
        urls: [
          ...args.options.sourceImageUrls,
          ...(args.options.maskImageUrl ? [args.options.maskImageUrl] : []),
        ],
      },
      signal,
    );
    const generation = !apiKey
      ? serviceUnavailable(
          "OpenAI image generation is not configured",
          "NOT_CONFIGURED",
        )
      : "status" in references
        ? references
        : await generateOpenAiImage(
            args.options,
            {
              sourceImageUrls: references.slice(
                0,
                args.options.sourceImageUrls.length,
              ),
              maskImageUrl: args.options.maskImageUrl
                ? references[args.options.sourceImageUrls.length]
                : undefined,
            },
            apiKey,
            signal,
          );
    signal.throwIfAborted();
    if ("status" in generation) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: generation.body.error },
        signal,
      );
      await set(completeRunBuiltInAdmission$, {
        admission: args.admission,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const result = await set(
      recordGeneratedImage$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        billingRunId: args.runId ?? null,
        billingContext: args.runId ? "run" : "runless",
        privateArtifacts: args.privateArtifacts,
        pricing: args.pricing,
        generation,
        generationId: args.generationId,
      },
      signal,
    );
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.generationId, result },
      signal,
    );
    await set(completeRunBuiltInAdmission$, {
      admission: args.admission,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

// Keep the deployed Images API contract until Responses tool billing is verified.
// This compatibility path is not used by jobs marked image-response.
export const runLegacyOpenAiImageJob$ = command(
  async ({ set }, args: LegacyImageJobArgs, signal: AbortSignal) => {
    const execution = await settle(set(execute$, args, signal), signal);
    signal.throwIfAborted();
    if (execution.ok) {
      return;
    }
    logger("ImageGeneration").error("Image generation failed", {
      generationId: args.generationId,
      model: args.options.model,
      provider: args.options.provider,
    });
    await set(
      failBuiltInGenerationJob$,
      {
        generationId: args.generationId,
        error: {
          message: "Image generation failed",
          code: "OPENAI_IMAGE_REQUEST_FAILED",
        },
      },
      signal,
    );
    await set(completeRunBuiltInAdmission$, {
      admission: args.admission,
      status: "failed",
    });
    signal.throwIfAborted();
  },
);

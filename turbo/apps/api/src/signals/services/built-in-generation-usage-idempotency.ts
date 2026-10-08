import { v5 as uuidv5 } from "uuid";

const BUILT_IN_GENERATION_USAGE_NAMESPACE =
  "7ed0d80f-a1be-4a53-b182-0195e2e8b7f4";

export function builtInGenerationUsageIdempotencyKey(parts: {
  readonly generationId: string;
  readonly category: string;
}): string {
  return uuidv5(
    `${parts.generationId}:image:${parts.category}`,
    BUILT_IN_GENERATION_USAGE_NAMESPACE,
  );
}

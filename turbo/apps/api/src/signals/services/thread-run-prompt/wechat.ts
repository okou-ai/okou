import { computed } from "ccstate";
import type { createWechatThreadContext } from "../wechat-context.service";
export function createWechatThreadPrompt(
  context$: ReturnType<typeof createWechatThreadContext>,
) {
  return computed(async (get) => {
    const context = await get(context$);
    return context
      ? {
          userPromptVariables: { message: context.prompt },
          systemPromptVariables: {
            integrationContext: context.appendSystemPrompt,
          },
          skillVolumes: [],
        }
      : null;
  });
}

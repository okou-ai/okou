import { createSignalsHelperRule } from "./signals-helper-rule.ts";

export default createSignalsHelperRule({
  name: "no-best-effort",
  helper: "bestEffort",
  description: "Disallow new Platform bestEffort usages",
  messageId: "noBestEffort",
  message:
    "Do not add bestEffort usages or legacy waivers. Existing usages may only be removed. Failures must propagate instead of being swallowed. See docs/app/signals/settle.md.",
});

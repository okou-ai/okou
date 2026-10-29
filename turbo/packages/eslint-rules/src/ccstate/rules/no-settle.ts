import { createSignalsHelperRule } from "./signals-helper-rule.ts";

export default createSignalsHelperRule({
  name: "no-settle",
  helper: "settle",
  description: "Disallow new Platform settle usages",
  messageId: "noSettle",
  message:
    "Do not add settle usages or legacy waivers. Existing usages may only be removed. Let failures propagate, derive request state from loadables, and read server state instead of branching on a settled result. See docs/app/signals/settle.md.",
});

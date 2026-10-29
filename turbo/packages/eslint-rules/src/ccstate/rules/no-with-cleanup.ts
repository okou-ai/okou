import { createSignalsHelperRule } from "./signals-helper-rule.ts";

export default createSignalsHelperRule({
  name: "no-with-cleanup",
  helper: "withCleanup",
  description: "Disallow new Platform withCleanup usages",
  messageId: "noWithCleanup",
  message:
    "Do not add withCleanup usages or legacy waivers. Existing usages may only be removed. Derive request state from loadables and preserve resource ownership. See docs/app/signals/withCleanup.md.",
});

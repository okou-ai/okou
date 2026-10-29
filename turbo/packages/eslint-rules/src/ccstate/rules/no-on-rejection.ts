import { createSignalsHelperRule } from "./signals-helper-rule.ts";

export default createSignalsHelperRule({
  name: "no-on-rejection",
  helper: "onRejection",
  description: "Require explicit review for Platform onRejection usage",
  messageId: "noOnRejection",
  message:
    "Do not add onRejection error callbacks. Let accept errors propagate and derive request state from the operation's loadable. Review infrastructure exceptions explicitly. See docs/app/signals/onRejection.md.",
});

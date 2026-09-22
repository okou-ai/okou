# Triggerless Popover keyboard focus

`@base-ui/react@1.7.0` always passes `triggerFocusTargetRef` to its
`FloatingFocusManager`, including controlled Popovers that have no Trigger.
In that case the ref exists but its `current` value is null. The trailing focus
guard coalesces the ref object before resolving it, so Tab from the last popup
control stops on an invisible guard instead of reaching the next page control.

The patch resolves that ref before selecting the existing portal outside
guard. The portal continues to own forward tab order and focus-out dismissal.
This fixes the reachable nullable-ref state without changing popup placement,
trigger behavior, keyboard events or application focus algorithms. Both ESM and
CommonJS runtime files carry the same one-expression correction.

The shared Popover tests exercise native forward and backward tab navigation
with no Trigger, both on the page and inside a Dialog. The composer page test
also covers leaving the nested template flyout without inserting a template.

Remove this patch when the installed Base UI version resolves an empty
`nextFocusableElement` ref before choosing the portal outside guard. Retain
the behavior regressions when upgrading the dependency.

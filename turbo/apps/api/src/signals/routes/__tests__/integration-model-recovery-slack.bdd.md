# integration-model-recovery-slack

## integration-model-recovery-slack-001

- Vitest: "integration model recovery in Slack > automatically continues a claude-code-oauth-token quota failure after switching accounts exactly once"
- Mode: run
- Given: A connected Slack DM already has one failed run classified as `usage_limit` on Claude Code OAuth, and the owner has added a replacement account of the same provider.
- When: The owner activates the replacement, activates it again, and has the Runner terminalize the automatically continued run.
- Then: The Slack run list grows from one to exactly two and stays there after repeated activation. The Runner receives `continue` and context for the original Slack channel and thread. Slack sets that thread to `processing` during recovery and `active` after completion.

## integration-model-recovery-slack-002

- Vitest: "integration model recovery in Slack > automatically continues a codex-oauth-token quota failure after switching accounts exactly once"
- Mode: run
- Given: A connected Slack DM already has one failed run classified as `usage_limit` on Codex OAuth, and the owner has added a replacement account of the same provider.
- When: The owner activates the replacement, activates it again, and has the Runner terminalize the automatically continued run.
- Then: The Slack run list grows from one to exactly two and stays there after repeated activation. The Runner receives `continue` and context for the original Slack channel and thread. Slack sets that thread to `processing` during recovery and `active` after completion.

## integration-model-recovery-slack-003

- Vitest: "integration model recovery in Slack > handles same-account reauthorization after invalid_credentials without blindly retrying an exhausted account"
- Mode: run
- Given: A Slack-triggered run failed with `invalid_credentials` on the owner's Claude subscription.
- When: The owner starts a reconnect authorization targeting the same personal provider account and successfully completes OAuth.
- Then: With the new authorization, readback shows two Slack runs, including the automatic continuation.

## integration-model-recovery-slack-004

- Vitest: "integration model recovery in Slack > handles same-account reauthorization after usage_limit without blindly retrying an exhausted account"
- Mode: run
- Given: A Slack-triggered run failed with `usage_limit` on the owner's Claude subscription.
- When: The owner starts a reconnect authorization targeting the same personal provider account and successfully completes OAuth.
- Then: Readback stays at one Slack run. Reauthorizing the same exhausted account does not start another run.

## integration-model-recovery-slack-005

- Vitest: "integration model recovery in Slack > continues after changing models when optional upstream profile metadata is absent"
- Mode: run
- Given: The owner has a Slack DM run that exhausted its Claude quota, and optional upstream profile metadata is absent. The owner links an eligible GPT subscription.
- When: The owner opens Slack's native model selector and submits `gpt-6-luna`.
- Then: The selector is available with usable recovery state and the Slack run list contains the failed and automatically continued run.

## integration-model-recovery-slack-006

- Vitest: "integration model recovery in Slack > ignores delayed Slack Stop events but lets the user stop an automatically continued Run"
- Mode: run
- Given: A failed Slack DM has automatically resumed after its owner activates another eligible subscription account. The new run is assigned to a Runner.
- When: Slack sends a delayed `agent_session_stopped` event from the original DM activity, then a fresh Stop event for the same conversation.
- Then: The delayed event leaves the new run running. The fresh event changes it to `cancelled`, and Slack restores the original thread's indicator to `active`.

## integration-model-recovery-slack-007

- Vitest: "integration model recovery in Slack > keeps an unclassified Run manual when switching subscription accounts"
- Mode: run
- Given: A Slack DM run failed with provider text suggesting a quota issue but without a structured failure reason. It reads as `failed` with reason `unknown`.
- When: The owner activates an alternate subscription account.
- Then: Reading the Slack run log still shows only the original run.

## integration-model-recovery-slack-008

- Vitest: "integration model recovery in Slack > continues after replacing the active subscription credentials"
- Mode: run
- Given: A Slack run exhausted its Claude usage quota and its owner's currently active personal Claude subscription still exists.
- When: The owner updates that provider with replacement credentials that belong to a different account.
- Then: The provider update succeeds, and the Slack run list contains the original and a new continuation.

## integration-model-recovery-slack-009

- Vitest: "integration model recovery in Slack > does not revive a archived conversation when switching subscriptions"
- Mode: run
- Given: A Slack DM has a failed run, and the owner has archived the conversation.
- When: The owner activates another eligible subscription account.
- Then: The switch does not start another recovery run. Slack run readback shows just the original failure.

## integration-model-recovery-slack-010

- Vitest: "integration model recovery in Slack > does not revive a manually-continued conversation when switching subscriptions"
- Mode: run
- Given: A Slack DM has a failed run, and the owner has already posted a manual continuation.
- When: The owner activates another eligible subscription account.
- Then: The switch does not start another recovery run. Slack run readback shows the original and the manual continuation.

## integration-model-recovery-slack-011

- Vitest: "integration model recovery in Slack > does not revive a non-model-failure conversation when switching subscriptions"
- Mode: run
- Given: A Slack DM has a failed run, and the run failed for `guest_home_filesystem_full` rather than a model failure.
- When: The owner activates another eligible subscription account.
- Then: The switch does not start another recovery run. Slack run readback shows just the original failure.

## integration-model-recovery-slack-012

- Vitest: "integration model recovery in Slack > continues the failed DM on GPT with its native indicator without changing the default"
- Mode: run
- Given: A Slack DM run using `claude-fable-5-1` failed and Slack shows a `Switch model` action linked to its failure. The owner links a GPT subscription, sets their global default to `gpt-6-astra`, and renames the thread.
- When: The owner opens the Slack model selector, submits `gpt-6-luna`, and replays the same modal submission.
- Then: The selector identifies GPT as the user's ChatGPT subscription and Auto as workspace-credit use. Saving confirms the model switch and updates the thread to `gpt-6-luna` while keeping the global default on `gpt-6-astra`. One new `continue` input and GPT run appear on the same thread, and Slack's native indicator reports `processing` there. Replay leaves the total at two Slack runs.

## integration-model-recovery-slack-013

- Vitest: "integration model recovery in Slack > rejects another sender and an old modal after the owner changes the model in Web"
- Mode: run
- Given: A failed Slack DM has an open recovery modal for its existing `claude-fable-5-1` thread selection.
- When: Another Slack sender submits Auto, then the owner changes the thread to `claude-sonnet-5-5` in Web and submits Auto with the old modal.
- Then: The other sender leaves the original selection alone. The stale submission displays `no longer current`, readback preserves `claude-sonnet-5-5`, and the Slack run history contains exactly two runs.

## integration-model-recovery-slack-014

- Vitest: "integration model recovery in Slack > recovers when the conversation's subscription becomes unavailable before launch"
- Mode: run
- Given: A Slack DM previously used a personal Claude subscription which its owner has now removed.
- When: The owner sends a follow-up. After admission fails, they open the recovery selector linked to that failure and select Auto.
- Then: The original thread exposes an `output.error` and Slack provides a model switch action pointing to that error event. The recovery selector opens and thread readback changes to `auto`.

## integration-model-recovery-slack-015

- Vitest: "integration model recovery in Slack > keeps the original error for a non-model failure"
- Mode: run
- Given: A Slack DM run failed because the guest home filesystem was full.
- When: The Runner reports completion with that non-model failure.
- Then: The thread contains a `run.failed` event and Slack receives nonempty error text. No Slack message includes a model-switch action.

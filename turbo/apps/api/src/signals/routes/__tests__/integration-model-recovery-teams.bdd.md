# integration-model-recovery-teams

## integration-model-recovery-teams-001

- Vitest: "integration model recovery in Teams > opens a native dialog and saves only the requesting owner's conversation"
- Mode: run
- Given: An onboarded, connected Teams user on paid native execution has a personal conversation using `claude-fable-5-1`. An authenticated Runner reports `account_verification_required` for a Teams-triggered run, and the bot posts an error card.
- When: The owner invokes the card's `Switch model` action via Teams `task/fetch`. A different Teams user submits the dialog for Auto, followed by the owner submitting the same choice.
- Then: The completion and dialog request return HTTP 200. Teams receives a native dialog with model selection state. The other user's submission reports `no longer current` and authenticated thread readback stays on `claude-fable-5-1`. The owner's submission reports `Switched to Auto`, thread readback becomes `auto`, Teams receives a typing activity, and the Teams run log contains two runs.

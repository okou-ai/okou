# integration-model-recovery-telegram

## integration-model-recovery-telegram-001

- Vitest: "integration model recovery in Telegram > switches from native message buttons and rejects another sender"
- Mode: run
- Given: A signed-in user links their Telegram identity to the official bot. Their private message starts a Telegram run, and the authenticated Runner reports `account_verification_required` for Claude. The bot supplies a `Switch model` inline button.
- When: A different Telegram sender presses the button in a bot-authenticated webhook update. The owner then opens the model choices, selects Auto, and replays the same choice.
- Then: The other sender receives `no longer current`. Auto appears in the owner's inline choices with callback data at most 64 bytes. The owner receives `Switched to Auto`, typing resumes, and the conversation reads back as `auto` while the user's global preference remains `claude-fable-5-1`. Two Telegram runs appear in the run log, the new Runner input is `continue`, and replay reports `no longer current`.

// Match Slack's attachment image bounds while preserving our Block Kit layout.
// https://docs.slack.dev/legacy/legacy-messaging/legacy-secondary-message-attachments/#legacy_fields
export const SLACK_PREVIEW_IMAGE_SIZE = { width: 360, height: 500 } as const;

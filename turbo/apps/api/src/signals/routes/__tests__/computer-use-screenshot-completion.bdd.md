# computer-use-screenshot-completion

## computer-use-screenshot-completion-001

- Vitest: "Computer Use screenshot completion > keeps an upload failure recoverable through ordinary completion"
- Mode: run
- Given: An organization member has a running Safari state command claimed by an authenticated connected host. The host has a 1440 × 900 PNG result. Object storage fails the first upload.
- When: The host submits successful completion with the screenshot, the owner reads command and content status, then the host retries ordinary completion.
- Then: The first completion returns HTTP 500. The command remains running with no completion time or result, and screenshot lookup returns HTTP 404. The retry succeeds. The owner sees `succeeded`, exact image dimensions and byte count, and private PNG download metadata for the command.

## computer-use-screenshot-completion-002

- Vitest: "Computer Use screenshot completion > drains an admitted upload before rejecting a cancelled API completion"
- Mode: run
- Given: An organization member has a running Safari state command claimed by an authenticated connected host. The host has a 1440 × 900 PNG result. The object store holds the admitted upload while the API completion is cancelled.
- When: The host submits successful completion with the screenshot, the owner reads command and content status, then the host retries ordinary completion.
- Then: While the upload is held the owner still sees the command running without a screenshot. After the upload drains, completion returns HTTP 500. The command remains running with no completion time or result, and screenshot lookup returns HTTP 404. The retry succeeds. The owner sees `succeeded`, exact image dimensions and byte count, and private PNG download metadata for the command.

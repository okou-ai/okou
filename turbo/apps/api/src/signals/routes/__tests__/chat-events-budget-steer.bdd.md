# chat-events-budget-steer

## chat-events-budget-steer-001

- Vitest: "run-targeted time budget steering through HTTP > the scheduled fallback warns active Runs and skips completed Runs"
- Mode: run
- Given: Two Runs reach the budget warning threshold, with one still active and the other completed.
- When: An operator calls the scheduled run-budget steering fallback with cron authorization and the owners read thread events.
- Then: The endpoint returns HTTP 200. The active Run's thread has an `input.budget` event, while the completed Run stays completed and its thread has no such warning.

## chat-events-budget-steer-002

- Vitest: "run-targeted time budget steering through HTTP > consumes the warning once and retains its run identity on replay"
- Mode: run
- Given: An active Run has a pending budget warning and the Sandbox holds its Run authorization.
- When: The Sandbox declares the warning steered twice, then polls for the next input.
- Then: Both declarations return `steered` and polling returns null. Thread readback shows the original warning and exactly one replacement budget event with the same message and Run ID.

## chat-events-budget-steer-003

- Vitest: "run-targeted time budget steering through HTTP > revokes an unsteered warning at completion and never gives it to the next run"
- Mode: run
- Given: An active Run has a pending unsteered budget warning.
- When: The Sandbox reports completion. The member starts a successor Run on the thread and its Sandbox polls for steering.
- Then: The original warning has exactly one `control.revoke` referencing the completed Run. The successor receives no steering input.

## chat-events-budget-steer-004

- Vitest: "run-targeted time budget steering through HTTP > a Run heartbeat does not warn another owner's overdue Run"
- Mode: run
- Given: Two different members each have an active Run past its budget-warning point.
- When: The first Sandbox sends a heartbeat and each member reads thread events. The second Sandbox subsequently sends its own heartbeat.
- Then: The first heartbeat produces a budget warning only on the first Run. The second thread remains without a warning until its own heartbeat produces one.

## chat-events-budget-steer-005

- Vitest: "run-targeted time budget steering through HTTP > acknowledges a Run heartbeat while the budget notification provider is delayed"
- Mode: run
- Given: An active Run has reached its budget-warning point and the external active-input notification is delayed.
- When: The Sandbox sends an authorized heartbeat and waits for the response while notification is still outstanding.
- Then: The heartbeat returns HTTP 200 before notification is released. The owner can read the resulting `input.budget` event.

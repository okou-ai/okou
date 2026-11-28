# time

## time-001

- Vitest: "time > returns a mocked timestamp"
- Mode: run
- Intent: review
- Given: The test clock is set to timestamp 1,700,000,000,000 milliseconds.
- When: A consumer reads the numeric clock value.
- Then: It receives 1,700,000,000,000.

## time-002

- Vitest: "time > accepts Date values for mocked time"
- Mode: run
- Intent: review
- Given: The test clock is set using a Date for `2026-01-02T03:04:05.000Z`.
- When: A consumer reads the numeric clock value.
- Then: It receives the equivalent epoch milliseconds.

## time-003

- Vitest: "time > returns a mocked Date"
- Mode: run
- Intent: review
- Given: The test clock is set to timestamp 1,700,000,000,000 milliseconds.
- When: A consumer reads the clock as a Date.
- Then: It receives a Date for that exact timestamp.

## time-004

- Vitest: "time > clears mocked time"
- Mode: run
- Intent: review
- Given: The test clock is set to 123 milliseconds.
- When: The clock override is cleared and the numeric clock is read.
- Then: The read no longer reports 123.

## time-005

- Vitest: "time > isolates scoped clocks across concurrent async work"
- Mode: run
- Intent: review
- Given: Two concurrent async clock scopes begin at timestamps 123 and 456.
- When: The first scope sets its clock to 124 after yielding. The second reads its clock before and after yielding.
- Then: The first scope finishes with 124 and the second reads and finishes with 456.

## time-006

- Vitest: "time > isolates a real-time scope from the legacy global override"
- Mode: run
- Intent: review
- Given: A global test clock override is set to 123 milliseconds.
- When: An independent real-time scope reads its clock, applies a local override of 456, yields, reads again, then clears its local override and exits.
- Then: The scope ignores 123, reads 456 after yielding and stops returning 456 after clearing its override. The global override is still 123 outside the scope.

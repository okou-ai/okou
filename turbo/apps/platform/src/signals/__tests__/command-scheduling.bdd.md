# Command scheduling

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [command-scheduling.test.ts](command-scheduling.test.ts).

## command-scheduling-001

Original test `Debounced commands preserve arguments and return only the latest result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L17).

- **Given** A debounced command accepts a value and repetition count.
- **When** The user submits “old” once and then “new” twice before the 20 ms delay expires.
- **Then** The first call is rejected with an AbortError. The latest call returns “newnew”, and only “new” executes.

## command-scheduling-002

Original test `New debounced work cancels an active command cooperatively`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L42).

- **Given** A debounced command has started processing “old” and is waiting to finish.
- **When** The user submits “new” before the old work is released.
- **Then** The old call is rejected with an AbortError after it cooperatively checks cancellation. The new call returns “new”.

## command-scheduling-003

Original test `A cancelled debounce can be reused without running the discarded command`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L66).

- **Given** A pending debounced call for “discarded” belongs to a caller that is then cancelled.
- **When** The user submits “latest” with a valid caller, followed by “invalid” with the cancelled caller.
- **Then** The discarded call is rejected with an AbortError carrying the cancellation reason, and the invalid call is rejected with that reason. Only “latest” executes and returns successfully.

## command-scheduling-004

Original test `Throttled commands serialize a leading call and share the latest trailing result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L91).

- **Given** A throttled command has a 1,000 ms interval and its first call, “first”, is still running.
- **When** At 200 ms the user submits “discarded”, then at 600 ms submits “latest” with a repetition count of two.
- **Then** No trailing work executes while the first call is running. At 1,000 ms, the first call returns “first” and both trailing callers receive “latestlatest”; only “first” and “latest” execute.

## command-scheduling-005

Original test `A failed trailing command rejects every caller and allows another execution`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L125).

- **Given** A throttled command with a 20 ms interval has completed an initial call successfully.
- **When** Two callers submit “fail” at 19 ms, then a caller submits “recovered” at 40 ms.
- **Then** Both “fail” callers are rejected with the same request failure. The later call executes and returns “recovered”.

## command-scheduling-006

Original test `debounce scheduling is isolated between Stores`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L160).

- **Given** Two separate Stores use the same debounced command with a 20 ms delay.
- **When** One Store submits “first” and the other submits “second”.
- **Then** Neither execution occurs immediately. Both calls complete with their own values, and both commands execute; scheduling in one Store does not replace the other Store’s work.

## command-scheduling-007

Original test `throttle scheduling is isolated between Stores`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L160).

- **Given** Two separate Stores use the same throttled command with a 20 ms interval.
- **When** One Store submits “first” and the other submits “second”.
- **Then** Both commands execute immediately and both calls return their own values; scheduling in one Store does not affect the other Store.

## command-scheduling-008

Original test `A background loop reports a failed round and runs the next one`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L185).

- **Given** A background loop is configured to fail on its first round and succeed on its next round.
- **When** The loop runs both rounds.
- **Then** The recorded rounds are “failed” followed by “succeeded”.

## command-scheduling-009

Original test `Waiting on a loop still surfaces its failed round`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts#L206).

- **Given** A loop operation is waiting for a round to finish.
- **When** That round throws “Round failed”.
- **Then** The wait rejects with an error containing “Round failed”.

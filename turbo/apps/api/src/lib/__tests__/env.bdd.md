# env

## env-001

- Vitest: "API environment lifetime > keeps validated and optional startup inputs until the instance is replaced"
- Mode: run
- Intent: review
- Given: An API instance starts with validated and optional inputs both set to `startup`. The environment inputs then change to `replacement`.
- When: The operator observes the original instance's configuration and starts and observes a replacement instance.
- Then: The original instance continues to read `startup`, and the replacement reads `replacement` for both inputs.

## env-002

- Vitest: "API environment lifetime > preserves optional precedence for process=process and packed=packed"
- Mode: run
- Intent: review
- Given: The optional startup value from the process is `process` and the packed deployment value is `packed`.
- When: The API instance starts and reads the optional input.
- Then: The input resolves to `process`.

## env-003

- Vitest: "API environment lifetime > preserves optional precedence for process= and packed=packed"
- Mode: run
- Intent: review
- Given: The optional startup value from the process is empty and the packed deployment value is `packed`.
- When: The API instance starts and reads the optional input.
- Then: The input resolves to `packed`.

## env-004

- Vitest: "API environment lifetime > preserves optional precedence for process=undefined and packed=packed"
- Mode: run
- Intent: review
- Given: The optional startup value from the process is absent and the packed deployment value is `packed`.
- When: The API instance starts and reads the optional input.
- Then: The input resolves to `packed`.

## env-005

- Vitest: "API environment lifetime > preserves optional precedence for process= and packed="
- Mode: run
- Intent: review
- Given: The optional startup value from the process is empty and the packed deployment value is empty.
- When: The API instance starts and reads the optional input.
- Then: The input resolves to an absent value.

## env-006

- Vitest: "API environment lifetime > preserves optional precedence for process=undefined and packed="
- Mode: run
- Intent: review
- Given: The optional startup value from the process is absent and the packed deployment value is empty.
- When: The API instance starts and reads the optional input.
- Then: The input resolves to an absent value.

## env-007

- Vitest: "API environment lifetime > isolates derived values with supported env overrides and clearing"
- Mode: run
- Intent: review
- Given: The instance's original validated and optional inputs are both `startup`, and its derived configuration has already been read twice.
- When: The test environment overrides the validated input to `override`, then clears the optional input, then clears all overrides.
- Then: Repeated original reads share one value. The override creates a new value with the updated validated input and original optional input. The optional input then becomes absent. Clearing restores both `startup` fields in a freshly derived value.

## env-008

- Vitest: "API environment lifetime > retains an absent derived configuration until its scope is replaced"
- Mode: run
- Intent: review
- Given: A derived environment configuration has no value and records how often it is loaded.
- When: Two reads use the same scope, then the scope is cleared and read again.
- Then: All reads return no value. The first two reads cause one load, and the new scope causes a second load.

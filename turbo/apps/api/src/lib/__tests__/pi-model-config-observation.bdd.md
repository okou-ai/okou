# pi-model-config-observation

## pi-model-config-observation-001

- Vitest: "Pi captured-config observation boundary > classifies captured generation {} as 1"
- Mode: run
- Intent: review
- Given: A Pi Run's captured model configuration has no schema version, plus provider credentials, account, gateway, authorization headers and prompt.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration` with value `1`.

## pi-model-config-observation-002

- Vitest: "Pi captured-config observation boundary > classifies captured generation {\"schemaVersion\":2} as 2"
- Mode: run
- Intent: review
- Given: A Pi Run's captured model configuration has schema version 2, plus provider credentials, account, gateway, authorization headers and prompt.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration` with value `2`.

## pi-model-config-observation-003

- Vitest: "Pi captured-config observation boundary > classifies captured generation {\"schemaVersion\":3} as 3"
- Mode: run
- Intent: review
- Given: A Pi Run's captured model configuration has schema version 3, plus provider credentials, account, gateway, authorization headers and prompt.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration` with value `3`.

## pi-model-config-observation-004

- Vitest: "Pi captured-config observation boundary > classifies captured generation {\"schemaVersion\":4} as unknown"
- Mode: run
- Intent: review
- Given: A Pi Run's captured model configuration has schema version 4, plus provider credentials, account, gateway, authorization headers and prompt.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration` with value `unknown`.

## pi-model-config-observation-005

- Vitest: "Pi captured-config observation boundary > classifies captured generation {\"schemaVersion\":5} as 5"
- Mode: run
- Intent: review
- Given: A Pi Run's captured model configuration has schema version 5, plus provider credentials, account, gateway, authorization headers and prompt.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration` with value `5`.

## pi-model-config-observation-006

- Vitest: "Pi captured-config observation boundary > classifies captured generation {\"schemaVersion\":6} as unknown"
- Mode: run
- Intent: review
- Given: A Pi Run's captured model configuration has schema version 6, plus provider credentials, account, gateway, authorization headers and prompt.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration` with value `unknown`.

## pi-model-config-observation-007

- Vitest: "Pi captured-config observation boundary > classifies captured generation {\"schemaVersion\":\"private-version\"} as unknown"
- Mode: run
- Intent: review
- Given: A Pi Run's captured model configuration has a private string as its schema version, plus provider credentials, account, gateway, authorization headers and prompt.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration` with value `unknown`.

## pi-model-config-observation-008

- Vitest: "Pi captured-config observation boundary > reports an unavailable captured config as unknown: undefined"
- Mode: run
- Intent: review
- Given: A Pi Run has no captured config.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration: "unknown"`.

## pi-model-config-observation-009

- Vitest: "Pi captured-config observation boundary > reports an unavailable captured config as unknown: undefined"
- Mode: run
- Intent: review
- Given: A Pi Run has an array as its captured config.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration: "unknown"`.

## pi-model-config-observation-010

- Vitest: "Pi captured-config observation boundary > reports an unavailable captured config as unknown: \"private-config\""
- Mode: run
- Intent: review
- Given: A Pi Run has a private string as its captured config.
- When: Its telemetry-safe generation classification is requested.
- Then: The output consists only of `piModelConfigGeneration: "unknown"`.

## pi-model-config-observation-011

- Vitest: "Pi captured-config observation boundary > leaves non-Pi snapshots unclassified: undefined"
- Mode: run
- Intent: review
- Given: The captured model configuration is empty and the agent type is absent.
- When: Its telemetry-safe Pi generation classification is requested.
- Then: There is no classification.

## pi-model-config-observation-012

- Vitest: "Pi captured-config observation boundary > leaves non-Pi snapshots unclassified: codex"
- Mode: run
- Intent: review
- Given: The captured model configuration is empty and the agent type is Codex.
- When: Its telemetry-safe Pi generation classification is requested.
- Then: There is no classification.

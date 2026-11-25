# morning-brief-notification-source

## morning-brief-notification-source-001

- Vitest: "Morning Brief notification source authorization > accepts an owned official daily-delivery run with accepted provenance"
- Mode: run
- Intent: review
- Given: The Run belongs to the user's Morning Brief automation, and the automation and Workflow both belong to that user and organization. The source reports the Official Morning Brief daily-delivery definition and the Run carries its accepted revision and artifact provenance.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is accepted.

## morning-brief-notification-source-002

- Vitest: "Morning Brief notification source authorization > authorizes the test definition and captured Runs across a rollout switch"
- Mode: run
- Intent: review
- Given: The Run belongs to the user's Morning Brief automation, and the automation and Workflow both belong to that user and organization. The live source or previously captured Run can identify either the production or internal-test Morning Brief definition.
- When: The policy evaluates a production Run with the test source, a test Run with the test source, and a test Run with the production source.
- Then: All three combinations are accepted.

## morning-brief-notification-source-003

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"automationId\":\"unrelated-automation\"}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the source points to an unrelated automation.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-004

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"automationOrgId\":\"other-org\"}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the automation belongs to another organization.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-005

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"automationOwnerUserId\":\"other-user\"}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the automation belongs to another user.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-006

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"workflowOrgId\":\"other-org\"}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the Workflow belongs to another organization.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-007

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"workflowOwnerUserId\":\"other-user\"}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the Workflow belongs to another user.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-008

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"officialDefinitionName\":null}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the source has no Official definition.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-009

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"officialDefinitionName\":\"other-official-workflow\"}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the source names a different Official Workflow.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-010

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"officialBlueprintKey\":null}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the source has no Official blueprint key.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-011

- Vitest: "Morning Brief notification source authorization > rejects unrelated, custom, or cross-owner source {\"officialBlueprintKey\":\"other-blueprint\"}"
- Mode: run
- Intent: review
- Given: The Run has accepted Morning Brief provenance and an otherwise valid owned daily-delivery source, but the source names a different Official blueprint.
- When: Morning Brief notification source authorization evaluates the Run.
- Then: The source is denied.

## morning-brief-notification-source-012

- Vitest: "Morning Brief notification source authorization > rejects a mounted Morning Brief skill without a source automation"
- Mode: run
- Intent: review
- Given: The Run has Morning Brief provenance. In one trial the Run has no automation ID. In the other there is no source record.
- When: Morning Brief notification source authorization evaluates each trial.
- Then: Both trials deny the source.

## morning-brief-notification-source-013

- Vitest: "Morning Brief notification source authorization > requires accepted Morning Brief provenance in addition to the live source"
- Mode: run
- Intent: review
- Given: The Run belongs to the user's Morning Brief automation, and the automation and Workflow both belong to that user and organization. In one trial the Run has no captured provenance and in the other it has a provenance record with no definitions.
- When: Morning Brief notification source authorization evaluates each trial.
- Then: Both trials deny the source.

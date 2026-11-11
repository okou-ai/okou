import { command, type Computed } from "ccstate";
import {
  renderRunPrompts,
  type SystemPromptVariables,
} from "./run-prompt-and-skills";
import { buildEmailPrompt } from "./email-prompt";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import { loadEmailSourceMessageContext$ } from "./email-source-message.service";
import type { createEmailThreadContext } from "./email-queued-launch-context.service";
import type { createEmailMailboxConnections } from "./email-mailbox-context.service";
import type {
  AgentRunContextSignals,
  ExecutionConnectorSignals,
} from "./agent-run-context.signals";

type Value<T> = T extends Computed<Promise<infer U>> ? U : never;

export interface ClaimPromptPreparation {
  readonly systemPromptVariables: SystemPromptVariables;
  readonly email: null | {
    readonly email: NonNullable<
      Value<ReturnType<typeof createEmailThreadContext>>
    >;
    readonly mailboxes: Value<ReturnType<typeof createEmailMailboxConnections>>;
    readonly snapshot: NonNullable<
      Value<ExecutionConnectorSignals["catalog$"]>
    >;
    readonly policies: Value<ExecutionConnectorSignals["permissionPolicies$"]>;
    readonly featureSwitchContext: Value<
      AgentRunContextSignals["featureSwitches$"]
    >;
    readonly orgId: string;
    readonly userId: string;
  };
}

/** Finish source-message IO before the atomic winner publishes the prompt. */
export const prepareClaimSystemPrompt$ = command(
  async (
    { set },
    input: ClaimPromptPreparation | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    signal.throwIfAborted();
    if (!input) {
      return undefined;
    }
    let variables = input.systemPromptVariables;
    if (input.email) {
      const email = input.email;
      const message = await set(loadEmailSourceMessageContext$, email, signal);
      signal.throwIfAborted();
      variables = {
        ...variables,
        integrationContext: buildEmailPrompt(
          email.email,
          resolveIntegrationNotePrompt({
            triggerSource: "email",
            featureSwitchContext: email.featureSwitchContext,
            emailHasConnectedMailbox: email.mailboxes.length > 0,
          }),
          email.mailboxes,
          message,
        ),
      };
    }
    return renderRunPrompts({
      systemPromptVariables: variables,
      userPromptVariables: {},
      skillVolumes: [],
    }).systemPrompt;
  },
);

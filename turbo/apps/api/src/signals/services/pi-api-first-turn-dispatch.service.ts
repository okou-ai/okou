import { command, createStore, state, type Command } from "ccstate";

import type { CreatorAuthorizedPiPreparation } from "./agent-run-create.service";
import type { PiApiFirstTurnPreparation } from "./pi-api-first-turn-preparation";
import type { PiApiFirstTurnActivation } from "./pi-api-first-turn-config";

type PiApiFirstTurnCommand = Command<
  Promise<void>,
  [PiApiFirstTurnActivation, PiApiFirstTurnPreparation | undefined, AbortSignal]
>;

type PiApiFirstTurnPreparationCommand = Command<
  PiApiFirstTurnPreparation,
  [CreatorAuthorizedPiPreparation]
>;
const configuredPreparationCommand$ = state<
  PiApiFirstTurnPreparationCommand | undefined
>(undefined);

const configuredPiApiFirstTurnCommand$ = state<
  PiApiFirstTurnCommand | undefined
>(undefined);
const configurationStore = createStore();

/** Configure the Pi API first-turn implementation from the API composition root. */
export function configurePiApiFirstTurnCommand(
  commandValue: PiApiFirstTurnCommand,
  preparationCommand: PiApiFirstTurnPreparationCommand,
): void {
  const configuredCommand = configurationStore.get(
    configuredPiApiFirstTurnCommand$,
  );
  if (configuredCommand !== undefined && configuredCommand !== commandValue) {
    throw new Error("Pi API first-turn command is already configured");
  }
  configurationStore.set(configuredPiApiFirstTurnCommand$, commandValue);
  configurationStore.set(configuredPreparationCommand$, preparationCommand);
}

export const dispatchConfiguredPiApiFirstTurn$ = command(
  async (
    { set },
    activation: PiApiFirstTurnActivation,
    preparation: PiApiFirstTurnPreparation | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    const commandValue = configurationStore.get(
      configuredPiApiFirstTurnCommand$,
    );
    if (commandValue === undefined) {
      throw new Error("Pi API first-turn command is not configured");
    }
    await set(commandValue, activation, preparation, signal);
  },
);

/** Internal creator seam: source authorization precedes speculative resource IO. */
export const prepareConfiguredPiApiFirstTurn$ = command(
  (
    { set },
    input: CreatorAuthorizedPiPreparation,
  ): PiApiFirstTurnPreparation => {
    if (input.triggerSource === "goal") {
      throw new Error("Unsupported Pi preparation source");
    }
    const commandValue = configurationStore.get(configuredPreparationCommand$);
    if (commandValue === undefined) {
      throw new Error("Pi API first-turn preparation is not configured");
    }
    return set(commandValue, input);
  },
);

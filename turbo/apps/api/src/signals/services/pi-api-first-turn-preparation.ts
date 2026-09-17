import { isDeepStrictEqual } from "node:util";

import type { PiAgentModelConfig } from "@okouai/pi-agent-runtime";
import type { PreparedPiApiTurn } from "@okouai/pi-agent-runtime/api";

import {
  normalizedApiFirstTurnFailure,
  piApiFirstTurnError,
  type PiApiFirstTurnError,
} from "../../lib/pi-api-first-turn-policy";
import { awaitWithSignal, settleIncludingAbort } from "../utils";
import type { PiApiFirstTurnActivation } from "./pi-api-first-turn-config";
import { recordPiAdmissionPreparation } from "./pi-preparation-timing.service";

export type PiApiFirstTurnPreparedInputs =
  | { readonly kind: "large-history" }
  | {
      readonly kind: "api";
      readonly model: PiAgentModelConfig;
      readonly runtime: PreparedPiApiTurn;
      readonly startedAt: number;
    };

export type PiPreparationDiscardReason =
  | "queued"
  | "claim-lost"
  | "stale"
  | "admission-failed"
  | "activation-finished";

/** The creator owns this attempt until pending activation takes it over. */
export class PiApiFirstTurnPreparation {
  readonly #activation: PiApiFirstTurnActivation;
  readonly #controller: AbortController;
  readonly #result: ReturnType<
    typeof settleIncludingAbort<PiApiFirstTurnPreparedInputs>
  >;
  readonly #startedAt: number;
  #adopted = false;
  #disposed = false;
  #failure:
    | { readonly ok: false; readonly error: PiApiFirstTurnError }
    | undefined;

  constructor(
    activation: PiApiFirstTurnActivation,
    controller: AbortController,
    operation: Promise<PiApiFirstTurnPreparedInputs>,
    signal: AbortSignal,
    startedAt: number,
  ) {
    this.#startedAt = startedAt;
    this.#activation = activation;
    this.#controller = controller;
    recordPiAdmissionPreparation(activation.runId, "started", this.#startedAt);
    // Observe rejection immediately, retaining the original typed failure for
    // the committed coordinator. Speculation cannot publish a run failure.
    this.#result = this.#observe(operation, signal);
  }

  async #observe(
    operation: Promise<PiApiFirstTurnPreparedInputs>,
    signal: AbortSignal,
  ) {
    // Retain this attempt's failure even when it precedes durable admission.
    const result = await settleIncludingAbort(operation);
    recordPiAdmissionPreparation(
      this.#activation.runId,
      result.ok ? "ready" : "failed",
      this.#startedAt,
    );
    if (!result.ok) {
      this.#failure = {
        ok: false,
        error: normalizedApiFirstTurnFailure(result.error, signal.aborted),
      };
      return this.#failure;
    }
    return result;
  }

  get failure() {
    return this.#adopted ? this.#failure : undefined;
  }

  async take(
    activation: PiApiFirstTurnActivation,
    signal: AbortSignal,
  ): Promise<PiApiFirstTurnPreparedInputs> {
    if (
      this.#adopted ||
      this.#disposed ||
      !isDeepStrictEqual(this.#activation, activation)
    ) {
      throw piApiFirstTurnError(
        "PI_LAUNCH_CONFIG_INVALID",
        "Pi preparation does not belong to this committed launch attempt",
      );
    }
    this.#adopted = true;
    recordPiAdmissionPreparation(activation.runId, "adopted", this.#startedAt);
    const result = await awaitWithSignal(this.#result, signal);
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }

  async dispose(reason: PiPreparationDiscardReason): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#controller.abort();
    recordPiAdmissionPreparation(
      this.#activation.runId,
      this.#adopted ? "released" : "discarded",
      this.#startedAt,
      reason,
    );
    // SDK initialization may ignore abort. Join it and release its eventual
    // session outside any run lifecycle lock, including losing admissions.
    const result = await this.#result;
    if (result.ok && result.value.kind === "api") {
      result.value.runtime.dispose();
    }
  }
}

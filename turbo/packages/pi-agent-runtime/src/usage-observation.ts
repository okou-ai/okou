import { createHash } from "node:crypto";

import type { PiApiUsageObservation } from "./api-types";

type Quantities = PiApiUsageObservation["tokens"];

function emptyQuantities(): Quantities {
  return { input: null, cacheRead: null, cacheCreation: null, output: null };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function quantity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function terminalResponse(type: unknown): boolean {
  return (
    type === "response.completed" ||
    type === "response.done" ||
    type === "response.incomplete" ||
    type === "response.failed"
  );
}

function invalidInputPartition(
  input: number | null,
  cacheRead: number | null,
  cacheCreation: number | null,
): boolean {
  if (input === null) return false;
  if (cacheRead !== null && cacheRead > input) return true;
  if (cacheCreation !== null && cacheCreation > input) return true;
  if (cacheRead === null || cacheCreation === null) return false;
  const total = cacheRead + cacheCreation;
  return !Number.isSafeInteger(total) || total > input;
}

/** One API execution owns this evidence; SDK/session/billing counters stay separate. */
export class PiUsageObserver {
  #tokens = emptyQuantities();
  #lost = false;
  #terminal = false;
  #finalOutput = false;
  #responses = 0;
  #identity: string | undefined;
  #identityConflict = false;

  loseCoverage(): void {
    this.#lost = true;
  }

  beginResponse(): void {
    this.#responses += 1;
    if (this.#responses > 1) {
      this.loseCoverage();
      this.#tokens = emptyQuantities();
      this.#terminal = false;
      this.#finalOutput = false;
      this.#identity = undefined;
    }
  }

  #identify(value: unknown): void {
    if (typeof value !== "string") return;
    const identity = createHash("sha256").update(value).digest("hex");
    if (this.#identity !== undefined && this.#identity !== identity) {
      this.#identityConflict = true;
      this.loseCoverage();
    }
    this.#identity = identity;
  }

  #parse(value: unknown): number | null {
    const result = quantity(value);
    if (value !== undefined && result === null) this.loseCoverage();
    return result;
  }

  responses(event: unknown): void {
    const envelope = record(event);
    if (
      envelope?.type !== "response.created" &&
      envelope?.type !== "response.in_progress" &&
      !terminalResponse(envelope?.type)
    ) {
      return;
    }
    const response = record(envelope?.response);
    if (!response) return;
    this.#identify(response.id);
    const usage = record(response.usage);
    if (!usage) {
      if (terminalResponse(envelope?.type)) {
        this.#terminal = false;
      }
      return;
    }
    this.#tokens = this.#responsesTokens(usage);
    this.#terminal = terminalResponse(envelope?.type);
  }

  #responsesTokens(usage: Record<string, unknown>): Quantities {
    const input = this.#parse(usage.input_tokens);
    const details = record(usage.input_tokens_details);
    if (usage.input_tokens_details !== undefined && !details) {
      this.loseCoverage();
    }
    let cacheRead = this.#parse(details?.cached_tokens);
    let cacheCreation = this.#parse(details?.cache_write_tokens);
    // Inclusive input zero proves every nonnegative input partition is zero.
    if (input === 0) {
      if (details?.cached_tokens === undefined) cacheRead = 0;
      if (details?.cache_write_tokens === undefined) cacheCreation = 0;
    }
    const cacheTotal =
      cacheRead !== null && cacheCreation !== null
        ? cacheRead + cacheCreation
        : null;
    const invalidPartition = invalidInputPartition(
      input,
      cacheRead,
      cacheCreation,
    );
    const validPartition =
      input !== null && cacheTotal !== null && !invalidPartition;
    if (invalidPartition) {
      this.loseCoverage();
      cacheRead = null;
      cacheCreation = null;
    }
    return {
      input: validPartition ? input - cacheTotal : null,
      cacheRead,
      cacheCreation,
      output: this.#parse(usage.output_tokens),
    };
  }

  messages(event: unknown): void {
    const envelope = record(event);
    if (!envelope) return;
    if (envelope.type === "message_stop") {
      this.#terminal = this.#finalOutput;
      return;
    }
    let usage: Record<string, unknown> | undefined;
    if (envelope.type === "message_start") {
      const message = record(envelope.message);
      this.#identify(message?.id);
      usage = record(message?.usage);
    } else if (envelope.type === "message_delta") {
      usage = record(envelope.usage);
      this.#finalOutput = quantity(usage?.output_tokens) !== null;
    }
    if (!usage) return;
    this.#tokens = {
      input: this.#update(usage, "input_tokens", this.#tokens.input),
      cacheRead: this.#update(
        usage,
        "cache_read_input_tokens",
        this.#tokens.cacheRead,
      ),
      cacheCreation: this.#update(
        usage,
        "cache_creation_input_tokens",
        this.#tokens.cacheCreation,
      ),
      output: this.#update(usage, "output_tokens", this.#tokens.output),
    };
  }

  #update(
    usage: Record<string, unknown>,
    field: string,
    previous: number | null,
  ): number | null {
    return Object.hasOwn(usage, field) ? this.#parse(usage[field]) : previous;
  }

  bedrock(event: unknown): void {
    const usage = record(record(event)?.usage);
    if (!usage) return;
    this.#tokens = {
      input: this.#parse(usage.inputTokens),
      cacheRead: this.#parse(usage.cacheReadInputTokens),
      cacheCreation: this.#parse(usage.cacheWriteInputTokens),
      output: this.#parse(usage.outputTokens),
    };
    this.#terminal = true;
  }

  snapshot(failed: boolean): PiApiUsageObservation {
    const tokens = this.#identityConflict ? emptyQuantities() : this.#tokens;
    const quantities = Object.values(tokens);
    const known = quantities.some((value) => {
      return value !== null;
    });
    const complete =
      !failed &&
      !this.#lost &&
      this.#terminal &&
      quantities.every((value) => {
        return value !== null;
      }) &&
      Number.isSafeInteger(
        quantities.reduce<number>((sum, value) => {
          return sum + (value ?? 0);
        }, 0),
      );
    return {
      tokens: { ...tokens },
      coverage: complete ? "complete" : known ? "partial" : "unavailable",
    };
  }
}

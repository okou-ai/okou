import { ZodError } from "zod";

type ConnectionStage =
  | "idle"
  | "identify-wait"
  | "session-limit-wait"
  | "gateway-discovery"
  | "application-discovery"
  | "websocket-handshake"
  | "awaiting-hello"
  | "awaiting-ready"
  | "awaiting-resumed"
  | "ready"
  | "backoff"
  | "stopped";

export interface ConnectionFailureInput {
  reason:
    | "connection-error"
    | "authentication"
    | "rate-limit"
    | "application-mismatch"
    | "invalid-event-or-storage-failure"
    | "invalid-frame"
    | "socket-close"
    | "socket-error"
    | "hello-timeout"
    | "heartbeat-send-error"
    | "heartbeat-timeout"
    | "server-reconnect"
    | "invalid-session"
    | "outbox-full";
  error?: unknown;
  closeCode?: number;
}

// Error messages, stacks, arbitrary names and validation issues may contain
// credentials or provider payloads. Only these fixed classifications leave here.
function exceptionType(error: unknown): string | null {
  if (error === undefined) return null;
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError") return "TimeoutError";
    if (error.name === "AbortError") return "AbortError";
    return "DOMException";
  }
  if (error instanceof ZodError) return "ValidationError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof Error) return "Error";
  return "Unknown";
}

interface ConnectionFailure {
  at: number;
  stage: ConnectionStage;
  reason: ConnectionFailureInput["reason"];
  httpStatus: number | null;
  exceptionType: string | null;
  closeCode: number | null;
  retryCount: number;
  retryDelayMs: number | null;
}

// Runtime-only details complement the existing durable retry counter. Keeping
// them out of relay state lets old and new deployments read the same checkpoint.
export class ConnectionDiagnostics {
  private stage: ConnectionStage = "idle";
  private stageStartedAt = Date.now();
  private httpStatus: number | null = null;
  private lastFailure: ConnectionFailure | null = null;

  transition(stage: ConnectionStage): void {
    this.stage = stage;
    this.stageStartedAt = Date.now();
    this.httpStatus = null;
    console.info(JSON.stringify({ event: "discord-gateway-stage", stage }));
  }

  response(status: number): void {
    this.httpStatus = status;
    console.info(
      JSON.stringify({
        event: "discord-gateway-response",
        stage: this.stage,
        httpStatus: status,
      }),
    );
  }

  failure(
    input: ConnectionFailureInput,
    retryCount: number,
    retryDelayMs: number | null = null,
  ): void {
    this.lastFailure = {
      at: Date.now(),
      stage: this.stage,
      reason: input.reason,
      httpStatus: this.httpStatus,
      exceptionType: exceptionType(input.error),
      closeCode: input.closeCode ?? null,
      retryCount,
      retryDelayMs,
    };
    console.warn(
      JSON.stringify({
        event: "discord-gateway-connection-failure",
        ...this.lastFailure,
      }),
    );
  }

  snapshot() {
    return {
      stage: this.stage,
      stageStartedAt: this.stageStartedAt,
      httpStatus: this.httpStatus,
      lastFailure: this.lastFailure,
    };
  }
}

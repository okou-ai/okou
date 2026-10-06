import { performance } from "node:perf_hooks";
import { TLSSocket } from "node:tls";
import type { Attributes, Span } from "@opentelemetry/api";
import { Client, type ClientConfig } from "pg";
import { safeSync } from "../signals/utils";

class QueryPhases {
  readonly startedAt = performance.now();
  readonly marks = new Map<string, number>();
  readonly synchronous = new Map<string, number>();
  coverage = "complete";
  ready = false;
  rows = 0;

  constructor(
    readonly span: Span | undefined,
    readonly ordinal: number,
  ) {}

  mark(name: string): void {
    if (!this.marks.has(name)) {
      this.marks.set(name, performance.now() - this.startedAt);
    }
  }

  finish(outcome: "success" | "error"): void {
    if (!this.span?.isRecording()) {
      return;
    }
    const attributes: Attributes = {
      "diag.pg.query.coverage": this.ready
        ? this.coverage
        : this.coverage === "complete"
          ? "settled_before_ready"
          : this.coverage,
      "diag.pg.query.outcome": outcome,
      "diag.pg.query.ordinal": this.ordinal,
      "diag.pg.query.client_await_ms": performance.now() - this.startedAt,
    };
    // Partial/overlapping observations are deliberately not presented as
    // timings of one SQL statement. No protocol payload is inspected.
    if (this.coverage === "complete") {
      for (const [name, duration] of this.marks) {
        attributes[`diag.pg.query.${name}_ms`] = duration;
      }
      for (const [name, duration] of this.synchronous) {
        attributes[`diag.pg.query.${name}_sync_ms`] = duration;
      }
      attributes["diag.pg.query.data_row_messages"] = this.rows;
      const readyAt = this.marks.get("ready");
      if (readyAt !== undefined) {
        attributes["diag.pg.query.ready_to_delivery_ms"] =
          performance.now() - this.startedAt - readyAt;
      }
    }
    this.span.setAttributes(attributes);
  }
}

/** Disposable Preview-only observations for the pinned pg 8.23 protocol. */
export class PreviewPgClient extends Client {
  private readonly startedAt: number;
  private readonly startup = new Map<string, number>();
  private readonly pending = new Set<QueryPhases>();
  private current: QueryPhases | undefined;
  private blockedUntilDrain = false;
  private initiallyReady = false;
  private delivered = false;
  private ordinal = 0;

  constructor(config?: string | ClientConfig) {
    const startedAt = performance.now();
    super(config);
    this.startedAt = startedAt;
    const connection = this.connection;
    const markStartup = (name: string): void => {
      safeSync(() => {
        if (!this.startup.has(name)) {
          this.startup.set(name, performance.now() - startedAt);
        }
      });
    };
    const onTcp = (): void => {
      markStartup("tcp_connected");
    };
    let tls: TLSSocket | undefined;
    const onSecure = (): void => {
      markStartup("tls_secure");
    };
    const onTls = (): void => {
      // pg's sslconnect means the TLS wrapper exists, not handshake success.
      markStartup("tls_wrapper");
      if (connection.stream instanceof TLSSocket) {
        tls = connection.stream;
        tls.once("secureConnect", onSecure);
      }
    };
    const onChallenge = (): void => {
      markStartup("auth_challenge");
    };
    const onAuth = (): void => {
      markStartup("auth_ok");
    };
    const onReady = (): void => {
      safeSync(() => {
        if (!this.initiallyReady) {
          this.initiallyReady = true;
          markStartup("ready");
          return;
        }
        this.current?.mark("first_response");
        this.current?.mark("ready");
        if (this.current) {
          this.current.ready = true;
        }
      });
    };
    const responseEvents = [
      "parseComplete",
      "bindComplete",
      "rowDescription",
      "dataRow",
      "commandComplete",
      "emptyQuery",
      "errorMessage",
    ] as const;
    const responseListeners = responseEvents.map((event) => {
      const listener = (): void => {
        safeSync(() => {
          this.current?.mark("first_response");
          this.current?.mark(event);
          if (event === "dataRow" && this.current) {
            this.current.rows += 1;
          }
        });
      };
      // Observe before pg's row parsing and callback delivery, without reading
      // the message. Raw socket chunks cannot identify query response bounds.
      connection.prependListener(event, listener);
      return { event, listener };
    });
    const onDrain = (): void => {
      this.blockedUntilDrain = false;
    };
    connection.once("connect", onTcp);
    connection.once("sslconnect", onTls);
    connection.once("authenticationCleartextPassword", onChallenge);
    connection.once("authenticationMD5Password", onChallenge);
    connection.once("authenticationSASL", onChallenge);
    connection.once("authenticationOk", onAuth);
    connection.prependListener("readyForQuery", onReady);
    this.on("drain", onDrain);
    connection.once("end", () => {
      connection.removeListener("connect", onTcp);
      connection.removeListener("sslconnect", onTls);
      connection.removeListener("authenticationCleartextPassword", onChallenge);
      connection.removeListener("authenticationMD5Password", onChallenge);
      connection.removeListener("authenticationSASL", onChallenge);
      connection.removeListener("authenticationOk", onAuth);
      connection.removeListener("readyForQuery", onReady);
      for (const { event, listener } of responseListeners) {
        connection.removeListener(event, listener);
      }
      tls?.removeListener("secureConnect", onSecure);
      this.removeListener("drain", onDrain);
      this.current = undefined;
    });

    const query = connection.query.bind(connection);
    connection.query = (...args) => {
      return this.observeSubmission("query", () => {
        return query(...args);
      });
    };
    const parse = connection.parse.bind(connection);
    connection.parse = (...args) => {
      return this.observeSubmission("parse", () => {
        return parse(...args);
      });
    };
    const bind = connection.bind.bind(connection);
    connection.bind = (...args) => {
      return this.observeSubmission("bind", () => {
        return bind(...args);
      });
    };
  }

  recordCheckout(span: Span | undefined): void {
    const first = !this.delivered;
    this.delivered = true;
    if (!span?.isRecording()) {
      return;
    }
    span.setAttribute("diag.pg.connection.first_checkout", first);
    if (first) {
      for (const [name, duration] of this.startup) {
        span.setAttribute(`diag.pg.connection.${name}_ms`, duration);
      }
      span.setAttribute(
        "diag.pg.connection.delivered_ms",
        performance.now() - this.startedAt,
      );
    }
  }

  beginQuery(
    span: Span | undefined,
    args: readonly unknown[],
  ): (outcome: "success" | "error") => void {
    const probe = new QueryPhases(span, ++this.ordinal);
    const first = args[0];
    const custom =
      typeof first === "object" && first !== null && "submit" in first;
    if (this.pending.size > 0 || custom || this.blockedUntilDrain) {
      this.blockedUntilDrain = true;
      probe.coverage = custom ? "custom_query" : "overlap_or_recovery";
      for (const pending of this.pending) {
        pending.coverage = "overlap_or_recovery";
      }
      this.current = undefined;
    } else {
      this.current = probe;
    }
    this.pending.add(probe);
    return (outcome) => {
      if (!probe.ready && probe.coverage === "complete") {
        // An error/timeout callback can precede ReadyForQuery. Do not reuse
        // its protocol observation for a recovery query before actual drain.
        this.blockedUntilDrain = true;
      }
      safeSync(() => {
        return probe.finish(outcome);
      });
      this.pending.delete(probe);
      if (this.current === probe) {
        this.current = undefined;
      }
    };
  }

  private observeSubmission(
    name: "query" | "parse" | "bind",
    operation: () => void,
  ): void {
    const probe = this.current;
    safeSync(() => {
      return probe?.mark("first_protocol_submit");
    });
    const startedAt = performance.now();
    // Delegate exactly once. This is enqueue/serialization time, not proof
    // of socket flush or server execution. Do not inspect SQL or bind data.
    const submitted = safeSync(operation);
    safeSync(() => {
      if (probe) {
        probe.synchronous.set(
          name,
          (probe.synchronous.get(name) ?? 0) + performance.now() - startedAt,
        );
      }
    });
    if ("error" in submitted) {
      throw submitted.error;
    }
  }
}

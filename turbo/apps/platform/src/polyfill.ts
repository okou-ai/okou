// Keep these capability shims until the supported browser floor supplies them.
// Lowering using/await using syntax does not define the disposal symbols.
if (typeof Symbol.dispose !== "symbol") {
  Object.defineProperty(Symbol, "dispose", {
    value: Symbol.for("Symbol.dispose"),
  });
}

if (typeof Symbol.asyncDispose !== "symbol") {
  Object.defineProperty(Symbol, "asyncDispose", {
    value: Symbol.for("Symbol.asyncDispose"),
  });
}

if (typeof URL.canParse !== "function") {
  URL.canParse = function canParse(url: string | URL, base?: string | URL) {
    if (arguments.length === 0) {
      throw new TypeError("URL.canParse requires a URL");
    }
    // Web IDL argument conversion errors must propagate, not become invalid URLs.
    const input = `${url}`;
    const baseInput = base === undefined ? undefined : `${base}`;
    try {
      new URL(input, baseInput);
      return true;
    } catch {
      return false;
    }
  };
}

if (typeof AbortSignal.any !== "function") {
  function anySignal(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    function onAbort(reason: unknown): void {
      controller.abort(reason);
    }

    for (const signal of signals) {
      if (signal.aborted) {
        onAbort(signal.reason);
        break;
      }

      signal.addEventListener(
        "abort",
        (event) => {
          const target = event.target as AbortSignal;
          onAbort(target.reason);
        },
        { signal: controller.signal },
      );
    }

    return controller.signal;
  }

  AbortSignal.any = anySignal;
}

if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolveDeferred: (value: T | PromiseLike<T>) => void = () => {
      throw new Error("Promise resolver was not initialized");
    };
    let rejectDeferred: (reason?: unknown) => void = () => {
      throw new Error("Promise rejecter was not initialized");
    };
    const promise = new Promise<T>((resolve, reject) => {
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });

    return { promise, resolve: resolveDeferred, reject: rejectDeferred };
  };
}

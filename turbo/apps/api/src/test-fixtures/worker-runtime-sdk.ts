// External Workers tracing SDK boundary for local HTTP lifecycle tests.
// The application, request runtime, routes, SQL and pg pool remain real.
export const tracing = Object.freeze({
  enterSpan<T>(
    _name: string,
    run: (span: {
      setAttribute: (key: string, value: unknown) => void;
      setAttributes: (attributes: Record<string, unknown>) => void;
    }) => T,
  ): T {
    return run({
      setAttribute() {},
      setAttributes() {},
    });
  },
});

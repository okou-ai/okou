// Sentry's Worker wrapper requires workerd's platform context. Preserve the
// production HTTP handler unchanged; telemetry is not the contract of this suite.
export function withSentry<T>(_options: unknown, handler: T): T {
  return handler;
}

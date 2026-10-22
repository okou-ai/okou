/**
 * Worker-build-only replacement for pg's optional libpq addon.
 * Importing pg (including its lazy native export) must not fail at startup.
 * The ordinary JavaScript Client/Pool are untouched; only constructing the
 * explicitly selected native client fails. No connection/query is simulated.
 */
class UnsupportedPgNative {
  constructor() {
    throw new Error(
      "pg-native/libpq is unsupported on Cloudflare Workers. Use pg's ordinary JavaScript Client/Pool with Hyperdrive; remove NODE_PG_FORCE_NATIVE and do not select pg.native. Route operations requiring libpq to the Node/Vercel API deployment.",
    );
  }
}

// pg's CommonJS native client expects require('pg-native') to be a constructor.
export = UnsupportedPgNative;

import { env as bindings } from "cloudflare:workers";

// Deployment adapter for the unmodified API crypto implementation, not a mock.
export function env(name) {
  return bindings[name];
}

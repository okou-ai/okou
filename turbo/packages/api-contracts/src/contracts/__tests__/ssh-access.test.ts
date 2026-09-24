import { describe, expect, it } from "vitest";
import { sshHostSchema } from "../ssh-access";

describe("SSH host inventory contract", () => {
  const host = {
    id: "a0000000-0000-4000-8000-000000000001",
    displayName: "Gateway",
    host: "gateway.example.com",
    port: 443,
    username: "deploy",
    learnedHostKey: null,
  };

  it("distinguishes ready from a diagnostic-only rebind state", () => {
    for (const availability of [
      { status: "ready" },
      { status: "blocked", reason: "needs_rebind" },
    ]) {
      expect(sshHostSchema.parse({ ...host, availability })).toStrictEqual({
        ...host,
        availability,
      });
    }
  });

  it("rejects ambiguous statuses and private configuration metadata", () => {
    for (const availability of [
      { status: "blocked" },
      { status: "ready", reason: "needs_rebind" },
      { status: "blocked", reason: "network_error" },
    ]) {
      expect(sshHostSchema.safeParse({ ...host, availability }).success).toBe(
        false,
      );
    }
    expect(
      sshHostSchema.safeParse({
        ...host,
        availability: { status: "blocked", reason: "needs_rebind" },
        configId: "a0000000-0000-4000-8000-000000000002",
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  admitMcpChatStatusWaiter,
  MCP_CHAT_STATUS_MAX_PRINCIPAL_WAITERS,
  MCP_CHAT_STATUS_MAX_RUNTIME_WAITERS,
} from "../mcp-chat-status-wait-admission";

describe("MCP chat status wait admission", () => {
  it("bounds one principal and releases its slots idempotently", () => {
    const principal = { userId: "user_one", orgId: "org_one" };
    const admissions = Array.from(
      { length: MCP_CHAT_STATUS_MAX_PRINCIPAL_WAITERS },
      () => {
        const admission = admitMcpChatStatusWaiter(principal);
        if (!admission) {
          throw new Error("Expected principal waiter admission");
        }
        return admission;
      },
    );
    try {
      expect(admitMcpChatStatusWaiter(principal)).toBeNull();
      admissions[0]?.release();
      admissions[0]?.release();
      const replacement = admitMcpChatStatusWaiter(principal);
      expect(replacement).not.toBeNull();
      replacement?.release();
    } finally {
      for (const admission of admissions) {
        admission.release();
      }
    }
  });

  it("bounds the API runtime across distinct principals and reuses capacity", () => {
    const admissions = Array.from(
      { length: MCP_CHAT_STATUS_MAX_RUNTIME_WAITERS },
      (_, index) => {
        const admission = admitMcpChatStatusWaiter({
          userId: `user_${index}`,
          orgId: `org_${index}`,
        });
        if (!admission) {
          throw new Error("Expected runtime waiter admission");
        }
        return admission;
      },
    );
    try {
      expect(
        admitMcpChatStatusWaiter({
          userId: "user_overflow",
          orgId: "org_overflow",
        }),
      ).toBeNull();
      admissions[0]?.release();
      const replacement = admitMcpChatStatusWaiter({
        userId: "user_replacement",
        orgId: "org_replacement",
      });
      expect(replacement).not.toBeNull();
      replacement?.release();
    } finally {
      for (const admission of admissions) {
        admission.release();
      }
    }
  });
});

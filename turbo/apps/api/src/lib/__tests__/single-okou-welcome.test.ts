import { describe, expect, it } from "vitest";

import { buildFeishuWelcomeMessage } from "../feishu-message-card";
import {
  buildSingleOkouWelcomeMessage,
  buildWelcomeMessage,
} from "../slack-connect-blocks";

describe("single Okou welcome messages", () => {
  it("does not name the workspace agent on Slack", () => {
    const legacy = JSON.stringify(buildWelcomeMessage("U123", "Research"));
    const single = JSON.stringify(buildSingleOkouWelcomeMessage("U123"));

    expect(legacy).toContain("Workspace Agent");
    expect(single).not.toContain("Agent");
    expect(single).not.toContain("Research");
    expect(single).toContain("describe what you need help with");
  });

  it("connects Feishu conversations to Okou instead of the agent", () => {
    const legacy = JSON.stringify(
      buildFeishuWelcomeMessage({ agentName: "Research", botName: "Helper" }),
    );
    const single = JSON.stringify(
      buildFeishuWelcomeMessage({
        agentName: "Research",
        botName: "Helper",
        singleOkou: true,
      }),
    );

    expect(legacy).toContain("Your current agent is **Research**.");
    expect(single).toContain("I connect Feishu conversations to Okou");
    expect(single).not.toContain("Research");
    expect(single).not.toContain("AI agents");
  });
});

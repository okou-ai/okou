import { describe, it, expect } from "vitest";
import { CAPABILITIES, CAPABILITY_META } from "../capabilities";

describe("CAPABILITIES", () => {
  it("should have exactly 49 capabilities", () => {
    expect(CAPABILITIES).toHaveLength(49);
  });

  it("should follow {resource}:{action} naming pattern", () => {
    for (const cap of CAPABILITIES) {
      expect(cap).toMatch(/^[a-z-]+(?::[a-z-]+)?:(read|write|delete)$/);
    }
  });

  it("should include artifact sharing capabilities", () => {
    expect(CAPABILITIES).toContain("artifact:read");
    expect(CAPABILITIES).toContain("artifact:write");
  });

  it("should include Slack read and write capabilities", () => {
    expect(CAPABILITIES).toContain("slack:read");
    expect(CAPABILITIES).toContain("slack:write");
    expect(CAPABILITIES).not.toContain("integration-slack:write");
  });

  it("should include separate Feishu and Lark messaging capabilities", () => {
    expect(CAPABILITIES).toContain("feishu:write");
    expect(CAPABILITIES).toContain("lark:write");
  });

  it("should include telegram read and write capabilities", () => {
    expect(CAPABILITIES).toContain("telegram:read");
    expect(CAPABILITIES).toContain("telegram:write");
  });

  it("should include teams write capability", () => {
    expect(CAPABILITIES).toContain("teams:write");
  });

  it("should include phone read and write capabilities", () => {
    expect(CAPABILITIES).toContain("phone:read");
    expect(CAPABILITIES).toContain("phone:write");
  });

  it("should include github read and write capabilities", () => {
    expect(CAPABILITIES).toContain("github:read");
    expect(CAPABILITIES).toContain("github:write");
  });

  it("should include file read and write capabilities", () => {
    expect(CAPABILITIES).toContain("file:read");
    expect(CAPABILITIES).toContain("file:write");
  });

  it("should include hosted-site read and write capabilities", () => {
    expect(CAPABILITIES).toContain("host:read");
    expect(CAPABILITIES).toContain("host:write");
  });

  it("should include managed browser read and write capabilities", () => {
    expect(CAPABILITIES).toContain("browser:read");
    expect(CAPABILITIES).toContain("browser:write");
  });

  it("should include managed maps read capability", () => {
    expect(CAPABILITIES).toContain("maps:read");
  });

  it("should include managed weather read capability", () => {
    expect(CAPABILITIES).toContain("weather:read");
  });

  it("should include managed scrape read capability", () => {
    expect(CAPABILITIES).toContain("scrape:read");
  });

  it("should include managed web-search read capability", () => {
    expect(CAPABILITIES).toContain("web-search:read");
    expect(CAPABILITIES).toContain("people-search:read");
  });

  it("should include managed social read capability", () => {
    expect(CAPABILITIES).toContain("social:read");
  });

  it("should include managed image recognition capability", () => {
    expect(CAPABILITIES).toContain("image-recognition:write");
  });

  it("should include managed finance read capability", () => {
    expect(CAPABILITIES).toContain("finance:read");
  });

  it("should include managed SEO read capability", () => {
    expect(CAPABILITIES).toContain("seo:read");
  });

  it("should include billing read and write capabilities", () => {
    expect(CAPABILITIES).toContain("billing:read");
    expect(CAPABILITIES).toContain("billing:write");
  });

  it("should include connector read and write capabilities", () => {
    expect(CAPABILITIES).toContain("connector:read");
    expect(CAPABILITIES).toContain("connector:write");
  });

  it("should include banking read capability", () => {
    expect(CAPABILITIES).toContain("banking:read");
  });

  it("should include chat thread read and write capabilities", () => {
    expect(CAPABILITIES).toContain("chat-thread:read");
    expect(CAPABILITIES).toContain("chat-thread:write");
  });

  it("should include chat event read and write capabilities", () => {
    expect(CAPABILITIES).toContain("chat-event:read");
    expect(CAPABILITIES).toContain("chat-event:write");
  });
});

describe("CAPABILITY_META", () => {
  it("should have metadata for every capability", () => {
    for (const cap of CAPABILITIES) {
      expect(CAPABILITY_META[cap]).toBeDefined();
      expect(CAPABILITY_META[cap].group).toBeTruthy();
      expect(CAPABILITY_META[cap].label).toBeTruthy();
    }
  });
});

import { describe, expect, it } from "vitest";

import { vncHostSchema } from "./vnc-access";

const host = {
  id: "68b6a112-c6ed-4ae5-a9d0-7eb73ac392db",
  displayName: "Classic desktop",
  host: "127.0.0.1",
  port: 5900,
  availability: { status: "ready" },
  authMethod: "vnc_password",
};

describe("VNC host inventory", () => {
  it("accepts the exact Mac classic password pairing without treating it as X509Vnc", () => {
    const classic = { ...host, securityType: "apple_vnc_password" };
    expect(vncHostSchema.parse(classic)).toStrictEqual(classic);
    expect(
      vncHostSchema.safeParse({
        ...host,
        authMethod: "username_password",
        securityType: "apple_vnc_password",
      }).success,
    ).toBe(false);
  });
});

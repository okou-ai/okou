import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalKerberosKeytab,
  canonicalKerberosTicket,
  decodeKerberosMaterial,
  encodeKerberosMaterial,
  encodeAndClearKerberosMaterial,
} from "./vnc-kerberos-format";
import {
  kerberosPrincipalSchema,
  vncKerberosAuthenticationSchema,
} from "./vnc-kerberos";

const initiator = { realm: "EXAMPLE.INVALID", components: ["alice"] };
const service = {
  realm: "EXAMPLE.INVALID",
  components: ["vnc", "host.example.invalid"],
};
const vectors = readFileSync(
  new URL(
    "../../../../../crates/kerberos-credentials/tests/fixtures/conformance.tsv",
    import.meta.url,
  ),
  "utf8",
)
  .trimEnd()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [name, mode, input, canonical, error] = line.split("\t");
    return {
      name: name!,
      mode: mode!,
      input: input!,
      canonical: canonical!,
      error: error!,
    };
  });
function bytes(hex: string) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
function parse(input: Uint8Array, mode: string) {
  return mode === "cache"
    ? canonicalKerberosTicket(input, initiator, service, 200).bytes
    : canonicalKerberosKeytab(input, initiator);
}
describe("K1 language-neutral public API conformance", () => {
  it.each(vectors)("$name", (vector) => {
    const input = bytes(vector.input);
    if (vector.error === "Ok") {
      const canonical = parse(input, vector.mode);
      expect(Buffer.from(canonical).toString("hex")).toBe(vector.canonical);
      canonical.fill(0);
    } else
      expect(() => {
        return parse(input, vector.mode);
      }).toThrow("Invalid Kerberos credential");
    expect(
      input.every((byte) => {
        return byte === 0;
      }),
    ).toBe(true);
  });
  it("rejects every truncated prefix of the valid service ticket", () => {
    const valid = bytes(vectors[0]!.input);
    for (let length = 0; length < valid.length; length++) {
      const prefix = valid.slice(0, length);
      expect(() => {
        return parse(prefix, "cache");
      }).toThrow();
      expect(
        prefix.every((byte) => {
          return byte === 0;
        }),
      ).toBe(true);
    }
  });
  it("refuses an expired or not-yet-valid upload and exact identity mismatches", () => {
    for (const now of [99, 1000])
      expect(() => {
        return canonicalKerberosTicket(
          bytes(vectors[0]!.input),
          initiator,
          service,
          now,
        );
      }).toThrow();
    expect(() => {
      return canonicalKerberosTicket(
        bytes(vectors[0]!.input),
        { ...initiator, components: ["Alice"] },
        service,
        200,
      );
    }).toThrow();
    expect(() => {
      return canonicalKerberosTicket(
        bytes(vectors[0]!.input),
        initiator,
        { ...service, realm: "OTHER.INVALID" },
        200,
      );
    }).toThrow();
  });
  it("refuses duplicate selected service records instead of choosing one", () => {
    const valid = bytes(vectors[0]!.input);
    // FILE4 header plus the independently encoded default principal occupies 40 bytes.
    const duplicate = new Uint8Array(valid.length + valid.length - 40);
    duplicate.set(valid);
    duplicate.set(valid.subarray(40), valid.length);
    expect(() => {
      return parse(duplicate, "cache");
    }).toThrow();
  });
  it("bounds base64 before decoding and refuses noncanonical spelling", () => {
    expect(() => {
      return decodeKerberosMaterial("A".repeat(87385));
    }).toThrow();
    expect(() => {
      return decodeKerberosMaterial("AB==");
    }).toThrow();
    expect(() => {
      return decodeKerberosMaterial("AA==\n");
    }).toThrow();
    const data = Uint8Array.of(1, 2, 3, 255);
    expect(decodeKerberosMaterial(encodeKerberosMaterial(data))).toEqual(data);
  });
  it("consumes canonical bytes even when an encoding operation fails", () => {
    const data = Uint8Array.of(1, 2, 3, 255);
    expect(encodeAndClearKerberosMaterial(data)).toBe("AQID/w==");
    expect(
      data.every((byte) => {
        return byte === 0;
      }),
    ).toBe(true);
    const oversized = new Uint8Array(65_537).fill(1);
    expect(() => {
      return encodeAndClearKerberosMaterial(oversized);
    }).toThrow();
    expect(
      oversized.every((byte) => {
        return byte === 0;
      }),
    ).toBe(true);
  });
  it("validates explicit identity UTF-8 budgets without normalizing case", () => {
    expect(kerberosPrincipalSchema.parse(initiator)).toEqual(initiator);
    for (const realm of ["", "a\u0085", "a\u0000", "\ud800", "é".repeat(128)])
      expect(
        kerberosPrincipalSchema.safeParse({ ...initiator, realm }).success,
      ).toBe(false);
    expect(
      kerberosPrincipalSchema.safeParse({
        ...initiator,
        components: Array(9).fill("a"),
      }).success,
    ).toBe(false);
    expect(
      kerberosPrincipalSchema.safeParse({
        realm: "a".repeat(255),
        components: Array(4).fill("b".repeat(255)),
      }).success,
    ).toBe(false);
  });
  it("keeps sources disjoint and never accepts an ambient-source request", () => {
    const source = {
      method: "qemu_kerberos_password",
      initiator,
      password: " exact password ",
    };
    expect(vncKerberosAuthenticationSchema.parse(source)).toEqual(source);
    expect(
      vncKerberosAuthenticationSchema.safeParse({ ...source, keytab: "AAAA" })
        .success,
    ).toBe(false);
    expect(
      vncKerberosAuthenticationSchema.safeParse({
        method: "qemu_kerberos_ticket",
        initiator,
        service,
      }).success,
    ).toBe(false);
  });
});

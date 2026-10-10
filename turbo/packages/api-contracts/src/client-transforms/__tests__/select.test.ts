import { describe, expect, it } from "vitest";

import {
  CLIENT_TYPE_APP,
  CLIENT_TYPE_DESKTOP,
} from "../../contracts/client-headers";
import { selectClientResponseTransforms } from "../select";
import type { ClientResponseTransform } from "../types";

function fixtureTransform(
  overrides: Partial<ClientResponseTransform>,
): ClientResponseTransform {
  return {
    client: "desktop",
    method: "GET",
    path: "/api/example/:id",
    status: 200,
    maxVersion: "1.2.3",
    since: "#38758",
    transform: (body) => {
      return body;
    },
    ...overrides,
  };
}

const bounded = fixtureTransform({ maxVersion: "1.2.3" });
const unbounded = fixtureTransform({ maxVersion: null });

function select(
  transforms: readonly ClientResponseTransform[],
  request: {
    readonly client?: string;
    readonly version?: string;
    readonly method?: string;
    readonly path?: string;
    readonly status?: number;
  },
): readonly ClientResponseTransform[] {
  return selectClientResponseTransforms({
    transforms,
    client: CLIENT_TYPE_DESKTOP,
    version: "1.2.3",
    method: "GET",
    path: "/api/example/:id",
    status: 200,
    ...request,
  });
}

describe("selectClientResponseTransforms", () => {
  it("selects a null maxVersion for every stable Desktop version", () => {
    for (const version of ["0.0.0", "1.2.3", "99.0.0"]) {
      expect(select([unbounded], { version })).toStrictEqual([unbounded]);
    }
  });

  it("selects a Desktop version equal to maxVersion", () => {
    expect(select([bounded], { version: "1.2.3" })).toStrictEqual([bounded]);
  });

  it("selects Desktop versions below maxVersion", () => {
    for (const version of ["1.2.2", "1.1.9", "0.99.99"]) {
      expect(select([bounded], { version })).toStrictEqual([bounded]);
    }
  });

  it("selects nothing for Desktop versions above maxVersion", () => {
    for (const version of ["1.2.4", "1.3.0", "2.0.0", "1.10.0"]) {
      expect(select([bounded], { version })).toStrictEqual([]);
    }
  });

  it("selects nothing for missing or unparseable versions", () => {
    for (const version of [
      undefined,
      "",
      "1.2",
      "1.2.3.4",
      "v1.2.3",
      "1.2.3-beta.1",
      "1.2.3+build.7",
      " 1.2.3",
      "99999999999999999999.0.0",
    ]) {
      expect(select([bounded, unbounded], { version })).toStrictEqual([]);
    }
  });

  it("selects nothing for other or missing client types", () => {
    for (const client of [undefined, CLIENT_TYPE_APP, "desktop", "DESKTOP"]) {
      expect(select([bounded, unbounded], { client })).toStrictEqual([]);
    }
  });

  it("selects only transforms for the response's method, path, and status", () => {
    const created = fixtureTransform({ status: 201 });
    const posted = fixtureTransform({ method: "POST" });
    const other = fixtureTransform({ path: "/api/example" });

    expect(
      select([created, posted, other, bounded], { status: 200 }),
    ).toStrictEqual([bounded]);
    expect(
      select([created, posted, other, bounded], { status: 201 }),
    ).toStrictEqual([created]);
  });

  it("never selects transforms for non-2xx responses", () => {
    const badRequest = fixtureTransform({ status: 400, maxVersion: null });

    expect(select([badRequest], { status: 400 })).toStrictEqual([]);
  });

  it("returns selected transforms in registry order", () => {
    const first = fixtureTransform({ maxVersion: "2.0.0", since: "#1" });
    const second = fixtureTransform({ maxVersion: "1.0.0", since: "#2" });
    const third = fixtureTransform({ maxVersion: null, since: "#3" });

    expect(select([first, second, third], { version: "1.0.0" })).toStrictEqual([
      first,
      second,
      third,
    ]);
    expect(select([first, second, third], { version: "1.5.0" })).toStrictEqual([
      first,
      third,
    ]);
  });

  it("rejects a registered maxVersion that is not a stable version", () => {
    const invalid = fixtureTransform({ maxVersion: "1.2" });

    expect(() => {
      return select([invalid], { version: "1.0.0" });
    }).toThrow(/stable x\.y\.z/u);
  });
});

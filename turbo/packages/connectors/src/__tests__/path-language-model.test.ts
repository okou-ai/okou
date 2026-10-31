import { describe, expect, it } from "vitest";
import cases from "./path-language-model.json";
import {
  PathCompiler,
  certifiesSelection,
  pathApplicability,
} from "../path-automaton";
import {
  AnalysisLimitError,
  InvalidPathError,
  WorkBudget,
  requestLanguage,
} from "../path-language";

describe("bounded path-language contract from the independent concrete oracle", () => {
  it("preserves a long Unicode literal within the graph and work budgets", () => {
    const path = `/${"😀".repeat(32000)}`;
    const forms = new PathCompiler().compile(path);
    expect(pathApplicability(requestLanguage(path), forms)).toMatchObject({
      possible: true,
      certain: true,
    });
  });
  it.each(["base", "rule"])(
    "preserves the existing 1100-segment %s positive",
    (kind) => {
      const path = Array.from({ length: 1100 }, (_, index) => {
        return `/seg-${index}`;
      }).join("");
      const compiler = new PathCompiler();
      const forms =
        kind === "base"
          ? compiler.compileApi(path, false, "/")
          : compiler.compile(path);
      expect(pathApplicability(requestLanguage(path), forms)).toMatchObject({
        possible: true,
        certain: true,
      });
    },
  );
  it("does not silently filter an invalid full literal chain", () => {
    expect(() => {
      return new PathCompiler().compile("/files/%C3{id}%A9");
    }).toThrow(InvalidPathError);
    const forms = new PathCompiler().compile("/files/%C3%A9{id}");
    expect(pathApplicability(requestLanguage("/files/éa"), forms).certain).toBe(
      true,
    );
  });
  for (const testCase of cases) {
    it(`${testCase.pattern} against ${testCase.path}`, () => {
      const forms = new PathCompiler().compile(testCase.pattern);
      const actual = pathApplicability(requestLanguage(testCase.path), forms);
      expect(actual).toEqual({
        possible: testCase.possible,
        certain: testCase.certain,
        minimum: testCase.minimum,
        maximum: testCase.maximum,
      });
    });
  }

  it("collapses equal URI spellings before source enumeration", () => {
    const forms = new PathCompiler().compile(`/files/${"%61".repeat(40)}`);
    expect(forms).toHaveLength(1);
    expect(
      pathApplicability(requestLanguage(`/files/${"a".repeat(40)}`), forms)
        .certain,
    ).toBe(true);
  });

  it("does not use a union of declaration forms as a universal match", () => {
    const forms = new PathCompiler().compile("/files/a%2Fb/{tail*}");
    expect(
      pathApplicability(requestLanguage("/files/a%2Fb/x"), forms),
    ).toMatchObject({ possible: true, certain: false });
  });

  it("rejects a derived specificity flip even when both identities remain applicable", () => {
    const compiler = new PathCompiler();
    const grant = pathApplicability(
      requestLanguage("/files/prefixx%61%62%63"),
      compiler.compile("/files/{id}%61%62%63"),
    );
    const deny = pathApplicability(
      requestLanguage("/files/prefixx%61%62%63"),
      compiler.compile("/files/prefix{id}"),
    );
    expect(grant.certain && deny.certain).toBe(true);
    expect(
      certifiesSelection(
        new Map([
          ["grant", { owner: "owner", proof: grant, tieRank: 1 }],
          ["deny", { owner: "owner", proof: deny, tieRank: 0 }],
        ]),
        new Set(["grant", "deny"]),
        "grant",
        false,
        new WorkBudget(),
      ),
    ).toBe(false);
  });

  it.each([
    [10, false, true],
    [20, false, false],
    [20, true, true],
    [21, true, false],
  ] as const)(
    "certifies owner priority %i with intent %s",
    (otherPriority, intent, expected) => {
      const candidates = new Map([
        [
          "winner",
          {
            owner: "chosen",
            proof: {
              possible: true,
              certain: true,
              minimum: [20],
              maximum: [20],
            },
            tieRank: 0,
          },
        ],
        [
          "other",
          {
            owner: "other",
            proof: {
              possible: true,
              certain: false,
              minimum: [1],
              maximum: [otherPriority],
            },
            tieRank: 0,
          },
        ],
      ]);
      expect(
        certifiesSelection(
          candidates,
          new Set(["winner"]),
          "winner",
          intent,
          new WorkBudget(),
        ),
      ).toBe(expected);
    },
  );

  it("reports declaration exhaustion without truncating forms", () => {
    expect(() => {
      return new PathCompiler().compile(`/files/${"a%2F".repeat(9)}`);
    }).toThrow(AnalysisLimitError);
  });

  it("reports exhaustion instead of a missing match", () => {
    expect(() => {
      return requestLanguage(
        "/files/%2564elegations%2Ffoo",
        new WorkBudget(10),
      );
    }).toThrow(AnalysisLimitError);
  });

  it.each([
    "/%",
    "/%C0%AF",
    "/%E7%AE",
    "/%00",
    "/%5c",
    "/%2e%2e",
    "/a%2F..",
    "/%253f",
    "/%2523",
    "/﹖",
    "/%252525252561",
    "/\ud800",
  ])("rejects raw/full-chain invalid path %s", (path) => {
    expect(() => {
      return requestLanguage(path);
    }).toThrow(InvalidPathError);
  });

  it.each([
    ["", "/", "/", true],
    ["/files/", "/", "/files", true],
    ["/files/", "/", "/files/", true],
    ["//", "/", "/", true],
    ["//", "/{id}", "/a", false],
    ["/files", "/{key*}", "/files", true],
    ["/files/{key+}", "/{id}", "/files/a", false],
    ["/files/{key+}", "/", "/files/a", true],
  ] as const)(
    "keeps base %s and relative rule %s correlated for %s",
    (base, rule, path, certain) => {
      const proof = pathApplicability(
        requestLanguage(path),
        new PathCompiler().compileApi(base, base.includes("{"), rule),
      );
      expect(proof.possible).toBe(certain);
      expect(proof.certain).toBe(certain);
    },
  );
});

import { object, string, union, never as zNever } from "zod";
import { renderKotlinFiles, renderKotlinTypes } from "../generate";

describe("canonical Kotlin command protocol proof", () => {
  it("requires one exact canonical success schema rather than guessing a response", () => {
    const receipt = object({ id: string() });
    const other = object({ id: string() });
    const render = (responses: Record<number, typeof receipt>) => {
      return renderKotlinFiles({
        types: [{ name: "Receipt", schema: receipt, direction: "output" }],
        routes: [
          {
            name: "create",
            response: "Receipt",
            route: { method: "POST", path: "/api/fixture", responses },
          },
        ],
      });
    };
    const unsupported: Record<number, typeof receipt>[] = [
      { 400: receipt },
      { 200: receipt, 201: receipt },
    ];
    for (const responses of unsupported)
      expect(() => {
        return render(responses);
      }).toThrow(/one canonical success/u);
    expect(() => {
      return render({ 201: other });
    }).toThrow(/does not match/u);
  });

  it("rejects a command union when only some variant pairs are disjoint", () => {
    const branch = object({ prompt: string(), stop: zNever().optional() });
    const schema = union([
      branch,
      branch,
      object({ stop: string(), prompt: zNever().optional() }),
    ]);
    expect(() => {
      return renderKotlinTypes([
        { name: "Command", direction: "input", schema },
      ]);
    }).toThrow(/ambiguous/u);
  });
});

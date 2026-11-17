import { object, string, union, never as zNever } from "zod";
import { renderKotlinFiles, renderKotlinTypes } from "../generate";
import { initContract } from "../../contracts/base";

describe("canonical Kotlin command protocol proof", () => {
  it("represents an explicit no-body success as Unit and rejects body/Unit mismatches", () => {
    const c = initContract();
    const receipt = object({ id: string() });
    const render = (
      response: string,
      schema: typeof receipt | ReturnType<typeof c.noBody>,
    ) => {
      return renderKotlinFiles({
        types: [{ name: "Receipt", schema: receipt, direction: "output" }],
        routes: [
          {
            name: "save",
            response,
            route: {
              method: "PATCH",
              path: "/api/fixture",
              responses: { 204: schema },
            },
          },
        ],
      });
    };
    expect(render("Unit", c.noBody()).get("CanonicalApi.kt")).toContain(
      "Response<Unit>",
    );
    expect(() => {
      return render("Receipt", c.noBody());
    }).toThrow(/does not match/u);
    expect(() => {
      return render("Unit", receipt);
    }).toThrow(/does not match/u);
  });
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

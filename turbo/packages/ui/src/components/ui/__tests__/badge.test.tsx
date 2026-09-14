import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/postcss";
import { render, screen } from "@testing-library/react";
import postcss from "postcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Badge } from "../badge";

describe("Badge", () => {
  const style = document.createElement("style");

  beforeAll(async () => {
    const packageRoot = existsSync(resolve(process.cwd(), "src/styles"))
      ? process.cwd()
      : resolve(process.cwd(), "packages/ui");
    const path = resolve(packageRoot, "src/styles/globals.css");
    const source = `${await readFile(path, "utf8")}
      @source "../components/ui/badge.tsx";
      @source inline("text-xs text-sm text-[10px] text-[11px] leading-7");
    `;
    const compiled = await postcss([tailwindcss()]).process(source, {
      from: path,
    });
    // Happy DOM does not implement cascade layers. Keep the real compiled
    // typography declarations in source order for the computed-style checks.
    const rules: string[] = [];
    compiled.root.walkRules((rule) => {
      const declarations = rule.nodes.filter((node) => {
        return (
          node.type === "decl" &&
          (node.prop === "font-size" ||
            node.prop === "line-height" ||
            node.prop === "--spacing" ||
            node.prop === "--tw-leading" ||
            node.prop.startsWith("--text-") ||
            node.prop.startsWith("--leading-"))
        );
      });
      if (declarations.length > 0) {
        rules.push(`${rule.selector} { ${declarations.join("; ")} }`);
      }
    });
    style.textContent = rules.join("\n");
    document.head.append(style);
  });

  afterAll(() => {
    style.remove();
  });

  it("renders its label in a span by default", () => {
    render(<Badge>Admin</Badge>);

    const badge = screen.getByText("Admin");
    expect(badge.tagName).toBe("SPAN");
    expect(badge).toHaveAttribute("data-slot", "badge");
  });

  it("composes the host element the caller supplies", () => {
    render(<Badge render={<code />}>0.882.5</Badge>);

    const badge = screen.getByText("0.882.5");
    expect(badge.tagName).toBe("CODE");
    expect(badge.querySelector("span")).toBeNull();
  });

  it("keeps the caller's classes alongside the shared ones", () => {
    render(<Badge className="text-muted-foreground">Pending</Badge>);

    const badge = screen.getByText("Pending");
    expect(badge).toHaveClass("text-muted-foreground");
    // The shared classes are the component's own decision, so assert that they
    // survive the merge rather than pinning the token names a test must not
    // depend on.
    expect(badge.className.split(/\s+/).length).toBeGreaterThan(1);
  });

  it.each([
    { className: undefined, fontSize: "11px" },
    { className: "text-xs", fontSize: "12px" },
    { className: "text-sm", fontSize: "14px" },
    { className: "text-[10px]", fontSize: "10px" },
    { className: "text-[11px]", fontSize: "11px" },
    { className: "text-xs leading-7", fontSize: "12px" },
  ])(
    "owns its line height with caller typography $className",
    ({ className, fontSize }) => {
      render(
        <>
          {["16px", "20px", "28px", "1.5"].map((lineHeight) => {
            return (
              <div key={lineHeight} style={{ fontSize: "11px", lineHeight }}>
                <Badge className={className}>Legacy</Badge>
              </div>
            );
          })}
        </>,
      );

      for (const badge of screen.getAllByText("Legacy")) {
        const computed = getComputedStyle(badge);
        expect(computed.fontSize).toBe(fontSize);
        expect(computed.lineHeight).toBe("1.375");
      }
    },
  );

  it("lets the caller override the slot and forwards other attributes", () => {
    render(
      <Badge data-slot="status-badge" data-status="completed">
        Completed
      </Badge>,
    );

    const badge = screen.getByText("Completed");
    expect(badge).toHaveAttribute("data-slot", "status-badge");
    expect(badge).toHaveAttribute("data-status", "completed");
  });

  it("forwards ref to the rendered element", () => {
    const ref = { current: null as HTMLElement | null };
    render(<Badge ref={ref}>Legacy</Badge>);

    expect(ref.current).toBe(screen.getByText("Legacy"));
  });
});

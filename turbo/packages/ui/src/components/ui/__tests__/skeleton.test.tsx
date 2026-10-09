import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton } from "../skeleton";

describe("Skeleton", () => {
  it("preserves caller-owned motion, fill, geometry and DOM attributes", () => {
    render(
      <Skeleton
        role="status"
        aria-label="Loading"
        aria-busy="true"
        className="motion-safe:animate-none bg-red-500 rounded-none h-4 w-20"
      />,
    );

    const placeholder = screen.getByRole("status", { name: "Loading" });
    expect(placeholder).toHaveAttribute("aria-busy", "true");
    expect(placeholder).toHaveClass(
      "motion-safe:animate-none",
      "bg-red-500",
      "rounded-none",
      "h-4",
      "w-20",
    );
    expect(placeholder).not.toHaveClass("motion-safe:animate-skeleton-pulse");
    expect(placeholder).not.toHaveClass("bg-skeleton");
    expect(placeholder).not.toHaveClass("rounded-lg");
  });
});

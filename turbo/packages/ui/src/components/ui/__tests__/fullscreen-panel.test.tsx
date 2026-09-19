import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FullscreenPanel } from "../fullscreen-panel";

function Preview() {
  const [count, setCount] = useState(0);
  return (
    <div role="region" aria-label="Preview content">
      <button
        onClick={() => {
          setCount(count + 1);
        }}
      >
        Count: {count}
      </button>
    </div>
  );
}

function App() {
  const [fullscreen, setFullscreen] = useState(false);
  const [open, setOpen] = useState(true);
  return (
    <div id="root">
      <section aria-label="Workspace">
        {open ? (
          <FullscreenPanel
            as="aside"
            aria-label="Preview"
            fullscreen={fullscreen}
          >
            <button
              onClick={() => {
                setFullscreen(!fullscreen);
              }}
            >
              {fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            </button>
            <button
              onClick={() => {
                setOpen(false);
              }}
            >
              Close preview
            </button>
            <Preview />
          </FullscreenPanel>
        ) : (
          <p>Preview closed</p>
        )}
      </section>
    </div>
  );
}

describe("FullscreenPanel", () => {
  it("escapes the workspace while retaining preview state and scroll position", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Count: 0" }));
    fireEvent.scroll(screen.getByRole("region", { name: "Preview content" }), {
      target: { scrollTop: 120 },
    });

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(
      screen.getByRole("button", { name: "Count: 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Preview content" }).scrollTop,
    ).toBe(120);
    expect(
      screen.getByRole("region", { name: "Workspace" }),
    ).not.toContainElement(
      screen.getByRole("complementary", { name: "Preview" }),
    );
    expect(document.getElementById("root")).toContainElement(
      screen.getByRole("complementary", { name: "Preview" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(
      screen.getByRole("button", { name: "Count: 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Preview content" }).scrollTop,
    ).toBe(120);
    expect(screen.getByRole("region", { name: "Workspace" })).toContainElement(
      screen.getByRole("complementary", { name: "Preview" }),
    );
  });

  it("removes a fullscreen preview when its owner unmounts", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(
      screen.getByRole("button", { name: "Exit fullscreen" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    expect(screen.getByText("Preview closed")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Preview" })).toBeNull();
  });
});

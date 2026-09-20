import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

function ReadingApp() {
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <div id="root">
      <FullscreenPanel
        fullscreen={fullscreen}
        scrollAnchor={{
          viewportSelector: '[aria-label="Document"]',
          anchorSelector: "li, p",
        }}
      >
        <button
          onClick={() => {
            setFullscreen(!fullscreen);
          }}
        >
          {fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        </button>
        <div role="region" aria-label="Document" data-wide={fullscreen}>
          <ul>
            <li>
              {Array.from({ length: 6 }, (_, index) => {
                return <p key={index}>Paragraph {index + 1}</p>;
              })}
            </li>
          </ul>
        </div>
      </FullscreenPanel>
    </div>
  );
}

function renderReflowingDocument() {
  render(<ReadingApp />);
  const viewport = screen.getByRole("region", { name: "Document" });
  const paragraphs = Array.from(viewport.querySelectorAll("p"));
  // happy-dom has no layout engine. Model the browser geometry at the DOM
  // boundary; data-wide changes during React's real mutation phase so this
  // also detects snapshots taken after, rather than before, the reflow.
  const wide = () => {
    return viewport.dataset.wide === "true";
  };
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => {
    return new DOMRect(0, 10, wide() ? 800 : 400, 100);
  });
  const item = screen.getByRole("listitem");
  vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => {
    return new DOMRect(
      0,
      10 - viewport.scrollTop,
      wide() ? 800 : 400,
      wide() ? 360 : 600,
    );
  });
  for (const [index, paragraph] of paragraphs.entries()) {
    vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(() => {
      return new DOMRect(
        0,
        10 + index * (wide() ? 60 : 100) - viewport.scrollTop,
        wide() ? 800 : 400,
        wide() ? 40 : 80,
      );
    });
  }
  return viewport;
}

function readingOffset(viewport: HTMLElement, text: string) {
  return (
    screen.getByText(text).getBoundingClientRect().top -
    viewport.getBoundingClientRect().top
  );
}

describe("FullscreenPanel", () => {
  it("keeps the visible paragraph in place when fullscreen changes line wrapping", () => {
    const viewport = renderReflowingDocument();
    fireEvent.scroll(viewport, { target: { scrollTop: 190 } });
    expect(readingOffset(viewport, "Paragraph 3")).toBe(10);

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(readingOffset(viewport, "Paragraph 3")).toBe(10);
    expect(viewport.scrollTop).toBe(110);

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(readingOffset(viewport, "Paragraph 3")).toBe(10);
    expect(viewport.scrollTop).toBe(190);
  });

  it("returns to the paragraph reached by scrolling in fullscreen", () => {
    const viewport = renderReflowingDocument();
    fireEvent.scroll(viewport, { target: { scrollTop: 190 } });
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    fireEvent.scroll(viewport, { target: { scrollTop: 295 } });
    expect(readingOffset(viewport, "Paragraph 6")).toBe(5);

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(readingOffset(viewport, "Paragraph 6")).toBe(5);
    expect(viewport.scrollTop).toBe(495);

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(readingOffset(viewport, "Paragraph 6")).toBe(5);
  });

  it("keeps a partially visible paragraph readable when reflow shortens it", () => {
    const viewport = renderReflowingDocument();
    fireEvent.scroll(viewport, { target: { scrollTop: 250 } });
    expect(readingOffset(viewport, "Paragraph 3")).toBe(-50);

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(readingOffset(viewport, "Paragraph 3")).toBe(0);
  });

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

import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ToggleButton } from "../toggle-button";

describe("ToggleButton", () => {
  it("supports controlled pointer and keyboard activation without submitting a form", async () => {
    const user = userEvent.setup();
    const ref = { current: null as HTMLButtonElement | null };
    function Form() {
      const [selected, setSelected] = useState(false);
      const [submitted, setSubmitted] = useState(false);
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
          }}
        >
          <ToggleButton
            ref={ref}
            selected={selected}
            onClick={() => {
              setSelected(!selected);
            }}
          >
            Bold
          </ToggleButton>
          <button type="submit">Submit</button>
          <output>{submitted ? "Submitted" : "Ready"}</output>
        </form>
      );
    }
    render(<Form />);
    const button = screen.getByRole("button", { name: "Bold" });
    expect(ref.current).toBe(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(" ");
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Ready");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByRole("status")).toHaveTextContent("Submitted");
  });

  it("removes the native title when tooltips are not enabled", () => {
    render(
      <ToggleButton selected={false} aria-label="Bold" title="Bold text">
        B
      </ToggleButton>,
    );
    expect(screen.getByRole("button", { name: "Bold" })).not.toHaveAttribute(
      "title",
    );
  });

  it("shows the accessible label on hover without a duplicate native title", async () => {
    const user = userEvent.setup();
    render(
      <ToggleButton
        selected
        showTooltip
        aria-label="Bold"
        title="Legacy bold title"
      >
        B
      </ToggleButton>,
    );
    const button = screen.getByRole("button", { name: "Bold" });
    expect(button).not.toHaveAttribute("title");
    await user.hover(button);
    expect(await screen.findByText("Bold")).toBeVisible();
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the tooltip on keyboard focus and dismisses it with Escape", async () => {
    const user = userEvent.setup();
    render(
      <ToggleButton selected={false} showTooltip aria-label="Bold">
        B
      </ToggleButton>,
    );
    await user.tab();
    const button = screen.getByRole("button", { name: "Bold" });
    expect(button).toHaveFocus();
    expect(await screen.findByText("Bold")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("Bold")).not.toBeInTheDocument();
    });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it.each(["inline", "tile"] as const)(
    "keeps a disabled %s toggle inactive while exposing its tooltip",
    async (layout) => {
      const user = userEvent.setup();
      const ref = { current: null as HTMLButtonElement | null };
      function Controls() {
        const [selected, setSelected] = useState(false);
        return (
          <>
            <ToggleButton
              ref={ref}
              layout={layout}
              selected={selected}
              disabled
              showTooltip
              aria-label="Bold"
              onClick={() => {
                setSelected(true);
              }}
            >
              B
            </ToggleButton>
            <button type="button">Next</button>
          </>
        );
      }
      render(<Controls />);
      const button = screen.getByRole("button", { name: "Bold" });
      expect(ref.current).toBe(button);
      expect(button).toBeDisabled();
      const trigger = button.closest<HTMLElement>(
        '[data-slot="tooltip-trigger"]',
      );
      if (!trigger)
        throw new Error("Disabled toggle tooltip trigger not found");
      await user.hover(trigger);
      expect(await screen.findByText("Bold")).toBeVisible();
      await user.click(button);
      await user.tab();
      expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
      expect(button).toHaveAttribute("aria-pressed", "false");
    },
  );
});

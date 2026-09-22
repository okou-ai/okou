import { createRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";

describe("Tooltip", () => {
  it("preserves a non-button host, its ref, and its accessible description", async () => {
    const user = userEvent.setup();
    const hostRef = createRef<HTMLSpanElement>();
    const { container } = render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            aria-describedby="remaining-credits"
            render={
              <span ref={hostRef} tabIndex={0}>
                Usage
              </span>
            }
          />
          <TooltipContent role="tooltip" id="remaining-credits">
            Remaining API credits
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const trigger = screen.getByText("Usage");
    expect(trigger.tagName).toBe("SPAN");
    expect(container.firstElementChild).toBe(trigger);
    expect(hostRef.current).toBe(trigger);
    expect(trigger).not.toHaveAttribute("role");

    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Remaining API credits",
    );
    expect(trigger).toHaveAccessibleDescription("Remaining API credits");
    await user.unhover(trigger);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    await user.tab();
    expect(trigger).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
  });

  it("merges button actions once and retains disabled loading semantics", async () => {
    const user = userEvent.setup();
    const onTriggerClick = vi.fn();
    const onButtonClick = vi.fn();
    function Action({ loading = false }: { loading?: boolean }) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              onClick={onTriggerClick}
              render={
                <Button
                  disabled={loading}
                  aria-busy={loading}
                  aria-label="Run report"
                  onClick={onButtonClick}
                >
                  Run
                </Button>
              }
            />
            <TooltipContent>Generate a report</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    const { rerender } = render(<Action />);
    const trigger = screen.getByRole("button", { name: "Run report" });

    await user.click(trigger);
    expect(onButtonClick).toHaveBeenCalledTimes(1);
    expect(onTriggerClick).toHaveBeenCalledTimes(1);
    await user.keyboard("{Enter}");
    expect(onButtonClick).toHaveBeenCalledTimes(2);
    expect(onTriggerClick).toHaveBeenCalledTimes(2);
    await user.keyboard(" ");
    expect(onButtonClick).toHaveBeenCalledTimes(3);
    expect(onTriggerClick).toHaveBeenCalledTimes(3);

    rerender(<Action loading />);
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-busy", "true");
    await user.click(trigger);
    await user.keyboard("{Enter} ");
    expect(onButtonClick).toHaveBeenCalledTimes(3);
    expect(onTriggerClick).toHaveBeenCalledTimes(3);
  });
});

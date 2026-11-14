import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequestCommit } from "../request-commit";

describe("RequestCommit", () => {
  it("does not invent a request on mount or ordinary rerender", () => {
    const onCommit = vi.fn();
    const view = render(<RequestCommit request={null} onCommit={onCommit} />);
    view.rerender(<RequestCommit request={null} onCommit={onCommit} />);
    expect(onCommit).not.toHaveBeenCalled();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("acknowledges the exact request after sibling DOM has committed", () => {
    const request = { revision: "prepared" };
    const onCommit = vi.fn((committed: typeof request) => {
      expect(committed).toBe(request);
      expect(screen.getByText("Prepared content")).toBeInTheDocument();
    });
    render(
      <>
        <p>Prepared content</p>
        <RequestCommit request={request} onCommit={onCommit} />
      </>,
    );
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("acknowledges semantic replacements but not the same request twice", () => {
    const prepared = {};
    const started = {};
    const onCommit = vi.fn();
    const view = render(
      <RequestCommit request={prepared} onCommit={onCommit} />,
    );
    view.rerender(<RequestCommit request={prepared} onCommit={onCommit} />);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(prepared);
    view.rerender(<RequestCommit request={started} onCommit={onCommit} />);
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(started);
  });
});

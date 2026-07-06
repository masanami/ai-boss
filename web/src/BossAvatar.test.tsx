import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import BossAvatar from "./BossAvatar";

describe("BossAvatar", () => {
  it("renders the normal expression with its Japanese label", () => {
    render(<BossAvatar expression="normal" />);
    expect(screen.getByRole("img", { name: "通常" })).toBeInTheDocument();
  });

  it("renders the satisfied expression with its Japanese label", () => {
    render(<BossAvatar expression="satisfied" />);
    expect(screen.getByRole("img", { name: "満足" })).toBeInTheDocument();
  });

  it("renders the displeased expression with its Japanese label", () => {
    render(<BossAvatar expression="displeased" />);
    expect(screen.getByRole("img", { name: "不機嫌" })).toBeInTheDocument();
  });

  it("renders the encouraging expression with its Japanese label", () => {
    render(<BossAvatar expression="encouraging" />);
    expect(screen.getByRole("img", { name: "激励" })).toBeInTheDocument();
  });

  it("maps each expression to a distinct image", () => {
    const expressions = [
      "normal",
      "satisfied",
      "displeased",
      "encouraging",
    ] as const;

    const srcs = expressions.map((expression) => {
      const { unmount } = render(<BossAvatar expression={expression} />);
      const src = screen.getByRole("img").getAttribute("src");
      unmount();
      return src;
    });

    expect(new Set(srcs).size).toBe(expressions.length);
  });
});

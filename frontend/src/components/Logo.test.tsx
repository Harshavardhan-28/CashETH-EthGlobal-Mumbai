import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Logo } from "./Logo";

describe("Logo", () => {
  it("scales the mark with the wordmark", () => {
    const { container } = render(<Logo size={30} />);
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    imgs.forEach((i) => expect(i).toHaveAttribute("width", "46"));
    expect(screen.getByText("ETH")).toBeInTheDocument();
  });

  it("is a link home", () => {
    render(<Logo />);
    expect(screen.getByRole("link", { name: "CashETH home" })).toHaveAttribute("href", "/");
  });
});

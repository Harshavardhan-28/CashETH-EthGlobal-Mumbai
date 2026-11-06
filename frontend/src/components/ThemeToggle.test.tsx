import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

const toggle = () => screen.getByRole("button", { name: /toggle color theme/i });

describe("ThemeToggle", () => {
  it("offers the opposite theme as its label", () => {
    render(<ThemeToggle />);
    expect(toggle()).toHaveTextContent("Light");
  });

  it("switches to light, persists the choice, and offers dark next", async () => {
    render(<ThemeToggle />);
    await userEvent.click(toggle());
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("casheth-theme")).toBe("light");
    expect(toggle()).toHaveTextContent("Dark");
  });

  it("picks up a theme the pre-paint script already applied", () => {
    document.documentElement.setAttribute("data-theme", "light");
    render(<ThemeToggle />);
    expect(toggle()).toHaveTextContent("Dark");
  });

  it("still toggles when storage is unavailable", async () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      render(<ThemeToggle />);
      await userEvent.click(toggle());
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
      expect(toggle()).toHaveTextContent("Dark");
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});

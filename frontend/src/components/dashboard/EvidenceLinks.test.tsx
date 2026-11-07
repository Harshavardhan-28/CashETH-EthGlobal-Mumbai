import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EvidenceLinks } from "./parts";

const links = [
  { label: "Settlement approval", url: "https://hashscan.io/testnet/transaction/0x2c4f" },
  { label: "Receivable NFT #8", url: "https://hashscan.io/testnet/token/0.0.11338934/8" },
];

describe("EvidenceLinks", () => {
  it("opens every verifiable link behind an invoice, each in a new tab", async () => {
    render(<EvidenceLinks links={links} />);
    await userEvent.click(screen.getByText("2 proof links"));
    const nft = screen.getByRole("link", { name: /Receivable NFT #8/ });
    expect(nft).toHaveAttribute("href", "https://hashscan.io/testnet/token/0.0.11338934/8");
    expect(nft).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /Settlement approval/ })).toHaveAttribute("href", "https://hashscan.io/testnet/transaction/0x2c4f");
  });

  it("shows a dash when there is nothing to verify yet", () => {
    render(<EvidenceLinks links={[]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

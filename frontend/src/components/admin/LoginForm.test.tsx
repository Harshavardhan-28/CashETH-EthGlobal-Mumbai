import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { LoginForm } from "./LoginForm";

const fetchMock = vi.fn();

beforeEach(() => {
  replace.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const reply = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );

async function submit(password: string) {
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginForm", () => {
  it("posts the password to the login route", async () => {
    reply(200, { ok: true });
    render(<LoginForm />);
    await submit("admin@01");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ password: "admin@01" });
  });

  it("shows the error on a wrong password and stays put", async () => {
    reply(401, { ok: false, error: "Wrong password" });
    render(<LoginForm />);
    await submit("nope");
    expect(await screen.findByText("Wrong password")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("goes to /admin on success", async () => {
    reply(200, { ok: true });
    render(<LoginForm />);
    await submit("admin@01");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/admin"));
  });

  it("shows a network error when the request fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<LoginForm />);
    await submit("x");
    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
  });

  it("focuses the password field", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Password")).toHaveFocus();
  });
});

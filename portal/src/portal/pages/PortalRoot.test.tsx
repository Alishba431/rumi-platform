import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// "/" is every Android app launch (the WebView boots at https://localhost/).
// It must honour an existing session instead of always showing the login
// form, or a force-close looks like a logout.

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { useAuth } from "../hooks/useAuth";
import PortalRoot from "./PortalRoot";

function renderWith(auth: { user: unknown; loading: boolean }) {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    user: auth.user,
    loading: auth.loading,
    login: vi.fn(),
    logout: vi.fn(),
  });
  render(
    <MemoryRouter>
      <PortalRoot />
    </MemoryRouter>
  );
}

describe("PortalRoot — '/' honours an existing session", () => {
  beforeEach(() => navigateSpy.mockClear());

  it("sends an authenticated teacher to the dashboard instead of the login form", () => {
    renderWith({ user: { id: "t-1", name: "Test Teacher" }, loading: false });
    expect(navigateSpy).toHaveBeenCalledWith("/portal/dashboard", { replace: true });
  });

  it("shows the login form when there is no session", () => {
    renderWith({ user: null, loading: false });
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /log in/i })).toBeInTheDocument();
  });

  it("does not flash the login form while the session check is still in flight", () => {
    renderWith({ user: null, loading: true });
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /log in/i })).not.toBeInTheDocument();
  });
});

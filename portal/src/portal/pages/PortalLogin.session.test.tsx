import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";

// An over-the-air app boots to /portal/login on every launch (src/lib/app-target.cjs,
// resolveOtaUrl). If the login page ignores a valid session, a signed-in teacher sees
// the form after every launch and concludes the app logged them out. The page must
// forward an existing session to the dashboard, and must not flash the form while the
// session check is in flight.

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { useAuth } from "../hooks/useAuth";
import PortalLogin from "./PortalLogin";

function renderLogin(auth: { user: unknown; loading: boolean }) {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ login: vi.fn(), ...auth });
  render(
    <MemoryRouter>
      <PortalLogin />
    </MemoryRouter>
  );
}

describe("PortalLogin — an existing session skips the form", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards an already-authenticated teacher to the dashboard", async () => {
    renderLogin({ user: { id: "t-1", name: "Test Teacher" }, loading: false });
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/portal/dashboard", { replace: true }));
  });

  it("does NOT show the login form to an authenticated user", async () => {
    renderLogin({ user: { id: "t-1", name: "Test Teacher" }, loading: false });
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(screen.queryByText("Log In")).toBeNull();
  });

  it("shows nothing while the session is still resolving", () => {
    renderLogin({ user: null, loading: true });
    expect(screen.queryByText("Log In")).toBeNull();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("shows the login form when there is genuinely no session", async () => {
    renderLogin({ user: null, loading: false });
    await waitFor(() => expect(screen.getByText("Log In")).toBeInTheDocument());
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("uses a fictional example number as the placeholder", () => {
    renderLogin({ user: null, loading: false });
    expect(screen.getByLabelText("Phone Number")).toHaveAttribute("placeholder", "15551234567");
  });
});

describe("PortalLogin — a successful login navigates once", () => {
  beforeEach(() => vi.clearAllMocks());

  // login() awaits the session check, which sets `user`, and the effect above
  // redirects. A second navigate from the submit handler would push the
  // dashboard twice, so browser Back from the dashboard lands on the dashboard.
  it("replaces /portal/login with the dashboard exactly once", async () => {
    vi.useFakeTimers();
    try {
      (useAuth as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const [user, setUser] = useState<unknown>(null);
        return {
          user,
          loading: false,
          login: async () => {
            setUser({ id: "t-1" });
            return { success: true };
          },
        };
      });
      render(
        <MemoryRouter>
          <PortalLogin />
        </MemoryRouter>
      );
      fireEvent.change(screen.getByLabelText("Phone Number"), { target: { value: "15551234567" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: /log in/i }).closest("form")!);
      });
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(navigateSpy.mock.calls).toEqual([["/portal/dashboard", { replace: true }]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

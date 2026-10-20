import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// The password can be right while the session cookie is not kept — the app
// talking to a server that does not allow it (PORTAL_APP_ENABLED off), or a
// browser blocking the cookie. login() must then report a failure; reporting
// success leaves the teacher on "Redirecting…" with nothing happening.

vi.mock("../services/api", () => ({
  auth: { login: vi.fn(), setup: vi.fn(), logout: vi.fn() },
  portal: { getDashboard: vi.fn() },
}));

import { auth, portal } from "../services/api";
import { useAuth } from "./useAuth";

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("useAuth.login — the session must actually exist afterwards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails with a clear message when the password is accepted but no session is kept", async () => {
    mocked(portal.getDashboard).mockRejectedValue(Object.assign(new Error("401"), { response: { status: 401 } }));
    mocked(auth.login).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { success: boolean; error?: string } = { success: true };
    await act(async () => {
      outcome = await result.current.login("15551234567", "pw");
    });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/sign-in didn't stick|session/i);
    expect(result.current.user).toBeNull();
  });

  it("succeeds when the session check finds the teacher", async () => {
    mocked(portal.getDashboard)
      .mockRejectedValueOnce(new Error("401"))
      .mockResolvedValue({ user: { id: "t-1", name: "Test Teacher" } });
    mocked(auth.login).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { success: boolean } = { success: false };
    await act(async () => {
      outcome = await result.current.login("15551234567", "pw");
    });
    expect(outcome.success).toBe(true);
    expect(result.current.user).toEqual({ id: "t-1", name: "Test Teacher" });
  });
});

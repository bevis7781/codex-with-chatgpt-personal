import { describe, expect, it } from "vitest";
import { planPersonalNamedTunnel } from "../src/tunnel/personal-default.js";

describe("Personal Named Tunnel preference", () => {
  it("derives a stable Named hostname without an interactive choice", () => {
    const plan = planPersonalNamedTunnel({
      preferredZone: "https://Example.COM/",
      state: { workspaceId: "abcdef123456", preference: "unset" },
      workspaceName: "My App",
      workspaceId: "abcdef123456",
    });
    expect(plan).toEqual({ zone: "example.com", hostname: "c2c-my-app.example.com" });
  });

  it("preserves an explicit existing Quick choice", () => {
    const plan = planPersonalNamedTunnel({
      preferredZone: "example.com",
      state: { workspaceId: "abcdef123456", preference: "quick", askedAt: "2026-09-21T00:00:00.000Z" },
      workspaceName: "My App",
      workspaceId: "abcdef123456",
    });
    expect(plan).toBeNull();
  });
});

import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

/**
 * A deliberately inert provider for the Secure MCP local-only Bridge.
 * OpenAI's tunnel-client owns the outbound control-plane connection; the C2C
 * Bridge must never try to create a second public tunnel in this mode.
 */
export class LocalOnlyTunnel implements TunnelProvider {
  readonly name = "local-only";

  async start(_localPort: number): Promise<string> {
    throw new Error("LOCAL_ONLY_TUNNEL_START_FORBIDDEN");
  }

  async stop(): Promise<void> {
    // There is no public-tunnel child to stop.
  }

  async restart(_localPort: number): Promise<string> {
    throw new Error("LOCAL_ONLY_TUNNEL_RESTART_FORBIDDEN");
  }

  status(): TunnelStatus {
    return { running: false, url: null, provider: this.name };
  }

  getPublicUrl(): string | null {
    return null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: null,
      running: false,
      url: null,
      problems: [],
    };
  }
}

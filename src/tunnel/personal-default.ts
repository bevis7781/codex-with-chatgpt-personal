import { parseZoneInput, suggestedNamedHostname } from "./hostname.js";
import { needsTunnelChoice, type TunnelState } from "./state.js";

export interface PersonalNamedTunnelPlan {
  zone: string;
  hostname: string;
}

/**
 * Resolve the machine's local Named-zone preference for a fresh workspace.
 * An explicit existing Quick/Named choice always wins over the preference.
 */
export function planPersonalNamedTunnel(opts: {
  preferredZone: string | null;
  state: TunnelState;
  workspaceName: string;
  workspaceId: string;
}): PersonalNamedTunnelPlan | null {
  if (!opts.preferredZone || !needsTunnelChoice(opts.state)) return null;
  const zone = parseZoneInput(opts.preferredZone);
  if (!zone) throw new Error("The configured preferred named zone is invalid.");
  return {
    zone,
    hostname: suggestedNamedHostname(zone, opts.workspaceName, opts.workspaceId),
  };
}

// @rome-protocol/registry ships JS + JSON (no bundled .d.ts yet). Minimal ambient
// declaration so the app type-checks; the returned shapes are chain/token records.
declare module "@rome-protocol/registry" {
  export function listChains(): any[];
  export function getChain(chainId: number): any;
  export function getTokens(chainId: number): any[];
  export function getContracts(chainId: number): any;
  export function getOracle(chainId: number): { factory: string; feeds: Record<string, { address: string; status?: string }> } | null;
  export function getPrograms(network: string): any;
}

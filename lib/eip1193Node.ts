import { createPublicClient, createWalletClient, http, type Account } from "viem";

/**
 * A minimal EIP-1193 provider backed by a viem account, so `submitRomeTx` — which
 * expects an injected wallet like `window.ethereum` — can run in Node (the demo
 * + deploy scripts). The web app passes the real `window.ethereum` instead.
 *
 * It answers `eth_accounts` / `eth_chainId` locally, signs + broadcasts
 * `eth_sendTransaction` with the account, and forwards every read
 * (`eth_estimateGas`, `eth_gasPrice`, `eth_getBlockByNumber`, …) to the RPC.
 */
export function eip1193FromAccount(account: Account, rpcUrl: string, chainId: number) {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(rpcUrl) });
  const big = (v: unknown) => (v === undefined || v === null ? undefined : BigInt(v as any));
  return {
    request: async ({ method, params }: { method: string; params?: any[] }) => {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [account.address];
        case "eth_chainId":
          return `0x${chainId.toString(16)}`;
        case "eth_sendTransaction": {
          const t = (params ?? [])[0] ?? {};
          return wallet.sendTransaction({
            to: t.to, data: t.data,
            value: big(t.value), gas: big(t.gas),
            maxFeePerGas: big(t.maxFeePerGas), maxPriorityFeePerGas: big(t.maxPriorityFeePerGas),
          } as any);
        }
        default:
          return pub.request({ method: method as any, params: params as any });
      }
    },
  };
}

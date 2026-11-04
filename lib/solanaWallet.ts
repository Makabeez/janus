// Any Wallet Standard Solana wallet as the Solana lane's signer. The v1 lane asks
// the wallet for two signatures per call: a readable authorization message, then
// the Solana v1 transaction itself. Both go through Wallet Standard, so there is
// no wallet-specific code here: a wallet that offers `solana:signMessage` and
// `solana:signTransaction` (for v1 transactions) works. The fund leg and the token-account
// creation are v1 transactions too, so they use the same signer.
import { getWallets } from "@wallet-standard/app";
import { PublicKey } from "@solana/web3.js";
import type { SolanaWallet } from "./rome";

export type Wallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
export type Account = Wallet["accounts"][number];

// Wallet Standard chain id for the cluster the registry names.
export const solanaChainId = (cluster: string) =>
  /^mainnet/.test(cluster) ? "solana:mainnet" : cluster === "testnet" ? "solana:testnet" : "solana:devnet";

const REQUIRED = ["standard:connect", "solana:signMessage", "solana:signTransaction"];
const usable = (w: Wallet, chain: string) => REQUIRED.every((f) => f in w.features) && (w.chains as readonly string[]).includes(chain);

// The registered wallets that can drive the lane on this chain. `onChange` runs
// again when a wallet registers later; call the returned function to stop.
export function listSolanaWallets(cluster: string, onChange: (wallets: Wallet[]) => void): () => void {
  const chain = solanaChainId(cluster);
  const { get, on } = getWallets();
  const emit = () => onChange(get().filter((w) => usable(w, chain)));
  emit();
  const offs = [on("register", emit), on("unregister", emit)];
  return () => offs.forEach((off) => off());
}

export async function connectSolanaWallet(wallet: Wallet): Promise<Account> {
  const { accounts } = await (wallet.features as any)["standard:connect"].connect();
  const [account] = accounts ?? [];
  if (!account) throw new Error(`${wallet.name} returned no account. Unlock it and try again.`);
  return account;
}

export function laneWallet(wallet: Wallet, account: Account, chain: string): SolanaWallet {
  const features = wallet.features as any;
  const signWire = async (transaction: Uint8Array): Promise<Uint8Array> => {
    const [{ signedTransaction }] = await features["solana:signTransaction"].signTransaction({ account, transaction, chain });
    return signedTransaction;
  };
  return {
    signer: {
      payer: new PublicKey(account.publicKey),
      signAuthHash: async (message) => {
        const [{ signature, signedMessage }] = await features["solana:signMessage"].signMessage({ account, message });
        // Wallet Standard lets a wallet alter the message before signing; Rome checks the exact bytes, so fail clearly here.
        if (signedMessage && (signedMessage.length !== message.length || signedMessage.some((b: number, i: number) => b !== message[i])))
          throw new Error(`${wallet.name} changed the authorization message before signing it.`);
        return signature; // 64 bytes
      },
      signV1Wire: async (wire) => (await signWire(wire)).slice(-64), // the 64-byte signature at the end of the signed wire
    },
  };
}

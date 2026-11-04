// Key-gate for the scripts: validate .env BEFORE any RPC call, so an unfilled or
// malformed key fails with instructions instead of a viem/web3.js stack trace.
// Names match the rome CLI (ROME_EVM_KEY / ROME_SOLANA_KEY) — one env, two tools.
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

function bail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** The EVM-lane signer. Exits with instructions if .env still holds the placeholder. */
export function requireEvmKey(): PrivateKeyAccount {
  const raw = process.env.ROME_EVM_KEY?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    bail(
      "ROME_EVM_KEY is not a real key yet. Fill it in .env: a 0x-prefixed 32-byte EVM private key,\n" +
        "funded with at least 1 USDC as Rome gas (bridge USDC in — `rome fund` — there is no faucet).",
    );
  }
  return privateKeyToAccount(raw as `0x${string}`);
}

/** The Solana-lane signer. Exits with instructions if .env still holds the placeholder. */
export function requireSolanaKey(): Keypair {
  const raw = process.env.ROME_SOLANA_KEY?.trim();
  let bytes: Uint8Array | undefined;
  try {
    const arr = JSON.parse(raw ?? "");
    if (Array.isArray(arr)) bytes = Uint8Array.from(arr);
  } catch {
    /* fall through to the message below */
  }
  if (!bytes || bytes.length !== 64) {
    bail(
      "ROME_SOLANA_KEY is not a real key yet. Fill it in .env: the JSON secret-key array that\n" +
        "solana-keygen writes (64 numbers, e.g. ~/.config/solana/id.json), funded with at least 0.6 USDC + 0.02 SOL.",
    );
  }
  return Keypair.fromSecretKey(bytes);
}

// `npm run demo` — headless proof that BOTH lanes trade the SAME Janus round.
// A MetaMask-style key bets UP and a Solana keypair bets DOWN (with no EVM key) on the
// current round; then both positions are read back from one contract.
import "dotenv/config";
import { formatUnits, type Hex } from "viem";
import { Connection, PublicKey } from "@solana/web3.js";
import { configFromEnv } from "../lib/config.js";
import { eip1193FromAccount } from "../lib/eip1193Node.js";
import { requireEvmKey, requireSolanaKey } from "../lib/keys.js";
import * as rome from "../lib/rome.js";

const cfg = configFromEnv();
const janus = process.env.JANUS_ADDRESS as Hex;
if (!janus) throw new Error("set JANUS_ADDRESS (npm run deploy)");
const evm = requireEvmKey();
const sol = requireSolanaKey();
const wallet: rome.SolanaWallet = { signer: sol };
const provider = eip1193FromAccount(evm, cfg.proxyUrl, cfg.chainId);
const synth = rome.syntheticFor(sol.publicKey);
const fmt = (x: bigint) => `${formatUnits(x, 6)} wUSDC`;
const meta = await rome.readMeta(cfg, janus);
const AMT = meta.minBet;

// Pre-flight funding check, so the run fails here with amounts instead of mid-run on-chain.
const conn = new Connection(cfg.solanaRpc, "confirmed");
const evmWei = await rome.publicClient(cfg).getBalance({ address: evm.address });
const lamports = await conn.getBalance(sol.publicKey);
const ata = await conn.getParsedTokenAccountsByOwner(sol.publicKey, { mint: new PublicKey(cfg.usdcMint) });
const usdc = ata.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
const short: string[] = [];
if (evmWei < 500_000_000_000_000_000n) short.push(`EVM ${evm.address}: ${formatUnits(evmWei, 18)} USDC gas (need ≥ 0.5)`);
if (usdc < AMT + 100_000n) short.push(`Solana ${sol.publicKey.toBase58()}: ${formatUnits(usdc, 6)} USDC (need ≥ ${formatUnits(AMT + 100_000n, 6)})`);
if (lamports < 20_000_000) short.push(`Solana ${sol.publicKey.toBase58()}: ${lamports / 1e9} SOL (need ≥ 0.02 for fees)`);
if (short.length) {
  console.error("Underfunded:\n  " + short.join("\n  "));
  process.exit(1);
}

const r = (await rome.publicClient(cfg).readContract({ address: janus, abi: rome.JANUS_ABI, functionName: "currentRound" })) as bigint;
console.log(`chain ${cfg.chainId} | Janus ${janus} | round ${r}`);
console.log(`EVM ${evm.address}\nSolana ${sol.publicKey.toBase58()} → synthetic ${synth}\n`);

const step = (lane: string) => (s: string, d?: string) => console.log(`  [${lane}] ${s}${d ? ` — ${d}` : ""}`);
await rome.evmBet(provider, evm.address, cfg, janus, r, true, AMT, step("EVM"));
await rome.solanaBet(cfg, wallet, janus, r, false, AMT, step("SOL"));

const rd = await rome.readRound(cfg, janus, r);
const a = await rome.readPosition(cfg, janus, r, evm.address);
const b = await rome.readPosition(cfg, janus, r, synth);
console.log(`\nround ${r}: UP pool ${fmt(rd.upPool)} | DOWN pool ${fmt(rd.downPool)}`);
console.log(`  MetaMask UP   ${fmt(a.up)}\n  Solana DOWN   ${fmt(b.down)}`);
if (a.up >= AMT && b.down >= AMT) console.log("\n✅ One round, two lanes: a MetaMask wallet and a Solana wallet are on opposite sides of the same Janus pool.");
else throw new Error("positions missing");

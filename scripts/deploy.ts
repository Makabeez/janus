// `npm run deploy` — compile contracts/Janus.sol and deploy it on the configured Rome chain.
// Resolves the BTC PriceBook + its Solana Pyth source account from the registry's
// BTC/USD-BOOK adapter (on-chain reads, never hardcoded), aligns genesis to the interval.
import "dotenv/config";
import { readFileSync } from "node:fs";
import solc from "solc";
import { createWalletClient, createPublicClient, encodeDeployData, http, getAddress, type Account, type Hex } from "viem";
import { configFromEnv, type RomeConfig } from "../lib/config.js";
import { requireEvmKey } from "../lib/keys.js";
import { BOOK_ABI, BOOK_ADAPTER_ABI } from "../lib/rome.js";

export function compileJanus() {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "Janus.sol": { content: readFileSync(new URL("../contracts/Janus.sol", import.meta.url), "utf8") } },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
      }),
    ),
  );
  if (out.errors?.some((e: any) => e.severity === "error")) throw new Error("solc: " + JSON.stringify(out.errors));
  const c = out.contracts["Janus.sol"].Janus;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` as Hex };
}

/** A minimal viem chain object for a Rome chain (native currency = USDC, 18-dec). */
export function romeChain(cfg: RomeConfig) {
  return { id: cfg.chainId, name: "Rome", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [cfg.proxyUrl] } } } as const;
}

export type JanusParams = { interval: bigint; tolerance: bigint; minBet: bigint; feeBps: number; treasury: Hex };

export function paramsFromEnv(deployer: Hex): JanusParams {
  const num = (k: string, d: string) => BigInt(process.env[k] || d);
  const p: JanusParams = {
    interval: num("INTERVAL_SEC", "1800"), // 30-min betting window, 30-min live window
    tolerance: num("TOLERANCE_SEC", "600"), // a print must land within 10 min of its target (Pyth devnet ~5-min cadence)
    minBet: num("MIN_BET", "100000"), // 0.1 wUSDC
    feeBps: Number(process.env.FEE_BPS || "100"), // 1%
    treasury: getAddress((process.env.TREASURY || deployer) as Hex),
  };
  if (p.tolerance >= p.interval) throw new Error("TOLERANCE_SEC must be < INTERVAL_SEC");
  return p;
}

export async function deployJanus(cfg: RomeConfig, account: Account, p: JanusParams) {
  const chain = romeChain(cfg);
  const pub = createPublicClient({ chain, transport: http(cfg.proxyUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(cfg.proxyUrl) });

  const book = (await pub.readContract({ address: cfg.btcFeedAdapter, abi: BOOK_ADAPTER_ABI, functionName: "book" })) as Hex;
  const feed = (await pub.readContract({ address: cfg.btcFeedAdapter, abi: BOOK_ADAPTER_ABI, functionName: "sourceAccount" })) as Hex;
  // Pre-flight: the book must answer for this feed, or every round would void.
  const [, , , status] = (await pub.readContract({ address: book, abi: BOOK_ABI, functionName: "entryOf", args: [feed] })) as any;
  if (Number(status) !== 1) throw new Error(`PriceBook ${book} has no live entry for ${feed} (status ${status})`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const genesis = ((now + p.interval - 1n) / p.interval) * p.interval; // next interval boundary
  const { abi, bytecode } = compileJanus();
  const args = [cfg.wusdc, book, feed, genesis, p.interval, p.tolerance, p.minBet, p.feeBps, p.treasury] as const;

  const gp = await pub.getGasPrice();
  // Rome prices Solana account creation into gas: estimate, then pad the LIMIT 1.15x (unused gas
  // is not charged). Do NOT pad the fee: measured on Hadrian, the receipt's effectiveGasPrice equals
  // maxFeePerGas, so every gwei of fee headroom is paid in full.
  const est = await pub.estimateGas({ account, data: encodeDeployData({ abi, bytecode, args }) });
  const gas = (est * 115n) / 100n;
  const need = gas * gp; // the node checks gas limit x max fee against the balance up front
  const have = await pub.getBalance({ address: account.address });
  if (have < need) {
    const fmt = (x: bigint) => (Number(x) / 1e18).toFixed(2);
    throw new Error(`deployer holds ${fmt(have)} USDC gas; the deploy needs ${fmt(need)} up front (expected spend ≈ ${fmt(est * gp)}). Bridge more USDC to Hadrian.`);
  }
  const hash = await wallet.deployContract({ abi, bytecode, args, gas, maxFeePerGas: gp, maxPriorityFeePerGas: 0n } as any);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`Janus deploy failed (tx ${hash})`);
  return { address: rcpt.contractAddress, hash, book, feed, genesis, args };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = configFromEnv();
  const account = requireEvmKey();
  const p = paramsFromEnv(account.address);
  console.log(`chain ${cfg.chainId} | deployer ${account.address} | wUSDC ${cfg.wusdc}`);
  console.log(`interval ${p.interval}s, tolerance ${p.tolerance}s, minBet ${p.minBet}, fee ${p.feeBps}bps, treasury ${p.treasury}`);
  const d = await deployJanus(cfg, account, p);
  console.log("Janus deployed:", d.address, "\n  tx", d.hash, "\n  book", d.book, "\n  feed", d.feed, "\n  genesis", new Date(Number(d.genesis) * 1000).toISOString());
  console.log(`→ set JANUS_ADDRESS=${d.address} in .env`);
  console.log(`→ explorer: ${cfg.explorerUrl.replace(/\/$/, "")}/address/${d.address}`);
}

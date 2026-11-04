// The dual-lane core for Janus. Both lanes act on the SAME Janus contract + the SAME wUSDC
// wrapper. Every function is environment-agnostic — the scripts feed a Node signer, the web
// app feeds a wallet (window.ethereum for MetaMask, Wallet Standard for a Solana wallet).
//
// Rome rules applied here (see AGENTS.md): every write goes through the SDK
// (`submitRomeTx` / `submitRomeTxV1`), each wallet grants the wUSDC wrapper once
// (`approve_spl` on the Helper precompile), and nothing is hardcoded that the registry knows.
import {
  submitRomeTx,
  submitRomeTxV1,
  syntheticAddress,
  buildFundLeg,
  buildSweepLeg,
  buildCreatePdaCall,
  isSyntheticProvisioned,
  submitSolanaInstructionsV1,
  toLaneSigner,
  type SignerLike,
} from "@rome-protocol/sdk";
import { createPublicClient, http, encodeFunctionData, erc20Abi, parseAbi, type Hex } from "viem";
import { Connection, PublicKey } from "@solana/web3.js";
import type { RomeConfig } from "./config.js";

export const JANUS_ABI = parseAbi([
  "function bet(uint256 r, bool up, uint256 amount)",
  "function claim(uint256[] rs)",
  "function lock(uint256 r)",
  "function settle(uint256 r)",
  "function voidRound(uint256 r)",
  "function currentRound() view returns (uint256)",
  "function startAt(uint256 r) view returns (uint64)",
  "function lockAt(uint256 r) view returns (uint64)",
  "function expiryAt(uint256 r) view returns (uint64)",
  "function getRound(uint256 r) view returns ((uint128 upPool, uint128 downPool, int64 strike, int64 closePrice, uint64 strikeTime, uint64 closeTime, uint128 payoutPool, uint8 status, bool upWon))",
  "function upStake(uint256, address) view returns (uint256)",
  "function downStake(uint256, address) view returns (uint256)",
  "function claimed(uint256, address) view returns (bool)",
  "function claimable(uint256 r, address who) view returns (uint256)",
  "function genesis() view returns (uint64)",
  "function interval() view returns (uint64)",
  "function tolerance() view returns (uint64)",
  "function minBet() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function treasury() view returns (address)",
  "function book() view returns (address)",
  "function feed() view returns (bytes32)",
  "event BetPlaced(uint256 indexed round, address indexed who, bool up, uint256 amount)",
  "event RoundLocked(uint256 indexed round, int64 strike, uint64 publishTime)",
  "event RoundSettled(uint256 indexed round, int64 closePrice, uint64 publishTime, bool upWon, uint256 fee)",
  "event RoundVoided(uint256 indexed round, string reason)",
  "event Claimed(address indexed who, uint256 indexed round, uint256 amount)",
]);

export const BOOK_ABI = parseAbi([
  "function entryOf(bytes32 sourceAccount) view returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status)",
  "function refreshAll(bytes32[] sourceAccounts) returns (uint256 committed, uint256 skipped, uint256 faulted)",
]);
export const BOOK_ADAPTER_ABI = parseAbi([
  "function book() view returns (address)",
  "function sourceAccount() view returns (bytes32)",
]);

export enum RoundStatus {
  Open = 0,
  Locked = 1,
  Settled = 2,
  Void = 3,
}
export type RoundState = {
  upPool: bigint;
  downPool: bigint;
  strike: bigint;
  closePrice: bigint;
  strikeTime: bigint;
  closeTime: bigint;
  payoutPool: bigint;
  status: RoundStatus;
  upWon: boolean;
};
export type JanusMeta = {
  genesis: bigint;
  interval: bigint;
  tolerance: bigint;
  minBet: bigint;
  feeBps: number;
  book: Hex;
  feed: Hex;
};

// Withdraw precompile (0x42..16): `withdraw_to_ata` wraps native gas (USDC) into the wUSDC wrapper.
const WITHDRAW = "0x4200000000000000000000000000000000000016" as const;
const WITHDRAW_ABI = parseAbi(["function withdraw_to_ata(uint256 wei_)"]);
// Helper precompile: the one-time wrapper grant (`approve_spl`). Without it a wUSDC
// transferFrom out of the wallet fails with SPL error 0x4.
const HELPER = "0xff00000000000000000000000000000000000009" as const;
const GRANT_ABI = parseAbi(["function approve_spl(address spender, uint64 amount, bytes32 mint)"]);
const WRAPPER_ABI = parseAbi(["function isEnabled(address user) view returns (bool)", "function mint_id() view returns (bytes32)"]);
const U64_MAX = 2n ** 64n - 1n;
/** wUSDC has 6 decimals; native gas USDC has 18 on the EVM side. */
const WEI_PER_WUSDC_UNIT = 10n ** 12n;

type Eip1193 = { request: (args: { method: string; params?: any[] }) => Promise<any> };
/** What a Solana user hands the lane helpers: a signer for Solana v1 transactions. */
export type SolanaWallet = { signer: SignerLike };

// ------------------------------ reads (either lane) ------------------------------
const clients = new Map<string, ReturnType<typeof createPublicClient>>();
export function publicClient(cfg: RomeConfig) {
  let c = clients.get(cfg.proxyUrl);
  if (!c) {
    c = createPublicClient({ transport: http(cfg.proxyUrl) });
    clients.set(cfg.proxyUrl, c);
  }
  return c;
}

export async function readMeta(cfg: RomeConfig, janus: Hex): Promise<JanusMeta> {
  const c = publicClient(cfg);
  const read = (functionName: any) => c.readContract({ address: janus, abi: JANUS_ABI, functionName }) as Promise<any>;
  const [genesis, interval, tolerance, minBet, feeBps, book, feed] = await Promise.all([
    read("genesis"), read("interval"), read("tolerance"), read("minBet"), read("feeBps"), read("book"), read("feed"),
  ]);
  return { genesis, interval, tolerance, minBet, feeBps: Number(feeBps), book, feed };
}

export async function readRound(cfg: RomeConfig, janus: Hex, r: bigint): Promise<RoundState> {
  const x = (await publicClient(cfg).readContract({ address: janus, abi: JANUS_ABI, functionName: "getRound", args: [r] })) as any;
  return { ...x, status: Number(x.status) as RoundStatus };
}

export type Position = { up: bigint; down: bigint; claimable: bigint; claimed: boolean };
export async function readPosition(cfg: RomeConfig, janus: Hex, r: bigint, who: Hex): Promise<Position> {
  const c = publicClient(cfg);
  const [up, down, claimable, claimed] = await Promise.all([
    c.readContract({ address: janus, abi: JANUS_ABI, functionName: "upStake", args: [r, who] }),
    c.readContract({ address: janus, abi: JANUS_ABI, functionName: "downStake", args: [r, who] }),
    c.readContract({ address: janus, abi: JANUS_ABI, functionName: "claimable", args: [r, who] }),
    c.readContract({ address: janus, abi: JANUS_ABI, functionName: "claimed", args: [r, who] }),
  ]);
  return { up: up as bigint, down: down as bigint, claimable: claimable as bigint, claimed: claimed as boolean };
}

/** The book's current BTC print (8 decimals) — read straight from the PriceBook, no staleness revert. */
export async function readPrint(cfg: RomeConfig, book: Hex, feed: Hex) {
  const [answer, publishTime, , status] = (await publicClient(cfg).readContract({
    address: book, abi: BOOK_ABI, functionName: "entryOf", args: [feed],
  })) as [bigint, bigint, bigint, number];
  return { price: answer, publishTime, live: Number(status) === 1 };
}

export function wusdcBalanceOf(cfg: RomeConfig, who: Hex): Promise<bigint> {
  return publicClient(cfg).readContract({ address: cfg.wusdc, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
}
function allowanceOf(cfg: RomeConfig, owner: Hex, spender: Hex): Promise<bigint> {
  return publicClient(cfg).readContract({ address: cfg.wusdc, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }) as Promise<bigint>;
}

/** The one-time wrapper grant `who` still needs, or null when the wrapper can already move their tokens. */
export async function wrapperGrantCall(cfg: RomeConfig, who: Hex): Promise<{ to: Hex; data: Hex } | null> {
  const client = publicClient(cfg);
  if (await client.readContract({ address: cfg.wusdc, abi: WRAPPER_ABI, functionName: "isEnabled", args: [who] })) return null;
  const mint = await client.readContract({ address: cfg.wusdc, abi: WRAPPER_ABI, functionName: "mint_id" });
  return { to: HELPER, data: encodeFunctionData({ abi: GRANT_ABI, functionName: "approve_spl", args: [cfg.wusdc, U64_MAX, mint] }) };
}

const betData = (r: bigint, up: boolean, amount: bigint) => encodeFunctionData({ abi: JANUS_ABI, functionName: "bet", args: [r, up, amount] });
const claimData = (rs: bigint[]) => encodeFunctionData({ abi: JANUS_ABI, functionName: "claim", args: [rs] });
const approveData = (spender: Hex) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, U64_MAX] });

// ------------------------------ EVM lane (MetaMask) ------------------------------
async function evmSend(provider: Eip1193, cfg: RomeConfig, step: string, tx: { from: Hex; to: Hex; data: Hex }) {
  const hash = await submitRomeTx(provider, tx);
  const receipt = await publicClient(cfg).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${step} reverted (tx ${hash}).`);
  return hash;
}

export type StepLog = (step: string, detail?: string) => void;

/**
 * Bet from a MetaMask wallet. Wraps only the wUSDC shortfall from native gas USDC, grants the
 * wrapper (first time), approves Janus (first time), then bets. Each step waits for its receipt,
 * so a later step never runs on top of one that reverted.
 */
export async function evmBet(provider: Eip1193, from: Hex, cfg: RomeConfig, janus: Hex, r: bigint, up: boolean, amount: bigint, log: StepLog = () => {}) {
  const have = await wusdcBalanceOf(cfg, from);
  if (have < amount) {
    log("wrap", "native USDC → wUSDC");
    await evmSend(provider, cfg, "wrap", { from, to: WITHDRAW, data: encodeFunctionData({ abi: WITHDRAW_ABI, functionName: "withdraw_to_ata", args: [(amount - have) * WEI_PER_WUSDC_UNIT] }) });
  }
  const grant = await wrapperGrantCall(cfg, from);
  if (grant) {
    log("grant", "one-time wrapper grant");
    await evmSend(provider, cfg, "wrapper grant", { from, ...grant });
  }
  if ((await allowanceOf(cfg, from, janus)) < amount) {
    log("approve", "one-time approve");
    await evmSend(provider, cfg, "approve", { from, to: cfg.wusdc, data: approveData(janus) });
  }
  log("bet", up ? "UP" : "DOWN");
  return evmSend(provider, cfg, "bet", { from, to: janus, data: betData(r, up, amount) });
}

export function evmClaim(provider: Eip1193, from: Hex, cfg: RomeConfig, janus: Hex, rounds: bigint[]) {
  return evmSend(provider, cfg, "claim", { from, to: janus, data: claimData(rounds) });
}

// ------------------------------ Solana lane (any Solana wallet) ------------------------------
// A Solana wallet user drives the same Janus with no EVM key. Their EVM identity is the synthetic
// address; value flows through it (fund leg in → act → sweep leg out), so it holds nothing at rest.
export function syntheticFor(payer: PublicKey): Hex {
  return syntheticAddress(payer);
}
function laneV1Deps(cfg: RomeConfig, signer: SignerLike) {
  return { connection: new Connection(cfg.solanaRpc, "confirmed"), proxyUrl: cfg.proxyUrl, chainId: cfg.chainId, programId: cfg.programId, signer };
}
const payerOf = (w: SolanaWallet) => toLaneSigner(w.signer).payer;
// A v1 call that lands on Solana can still revert in the EVM (a relayed call does not throw),
// or its receipt can time out. Treat both as failure so a flow never moves past a failed step.
async function landed<R extends { receipt: { status?: string } | null }>(step: string, call: Promise<R>): Promise<R> {
  const r = await call;
  if (r.receipt?.status !== "0x1") throw new Error(`${step} did not succeed: ${r.receipt ? "the call reverted" : "no receipt arrived in time"}.`);
  return r;
}

async function solanaFundTo(cfg: RomeConfig, wallet: SolanaWallet, amount: bigint) {
  const payer = payerOf(wallet);
  const synthetic = syntheticAddress(payer);
  const balance = await wusdcBalanceOf(cfg, synthetic);
  if (balance >= amount) return undefined; // only the shortfall moves, so a retried bet reuses what is there
  return submitSolanaInstructionsV1(
    buildFundLeg({ programId: cfg.programId, chainId: cfg.chainId, mint: new PublicKey(cfg.usdcMint), amount: amount - balance, wallet: payer, synthetic }),
    { connection: new Connection(cfg.solanaRpc, "confirmed"), signer: wallet.signer },
  );
}

/**
 * Bet from a Solana wallet. v1 calls that need no USDC go first (provision, approve), so a wallet
 * that cannot sign v1 transactions stops before the fund leg moves any USDC.
 */
export async function solanaBet(cfg: RomeConfig, wallet: SolanaWallet, janus: Hex, r: bigint, up: boolean, amount: bigint, log: StepLog = () => {}) {
  const synthetic = syntheticAddress(payerOf(wallet));
  const deps = laneV1Deps(cfg, wallet.signer);
  if (!(await isSyntheticProvisioned(deps.connection, cfg.programId, synthetic))) {
    log("provision", "one-time synthetic setup");
    await landed("provision", submitRomeTxV1(deps, buildCreatePdaCall(synthetic)));
  }
  if ((await allowanceOf(cfg, synthetic, janus)) < amount) {
    log("approve", "one-time approve");
    await landed("approve", submitRomeTxV1(deps, { to: cfg.wusdc, data: approveData(janus) }));
  }
  log("fund", "USDC → synthetic");
  await solanaFundTo(cfg, wallet, amount);
  const grant = await wrapperGrantCall(cfg, synthetic);
  if (grant) {
    log("grant", "one-time wrapper grant");
    await landed("wrapper grant", submitRomeTxV1(deps, grant));
  }
  log("bet", up ? "UP" : "DOWN");
  return landed("bet", submitRomeTxV1(deps, { to: janus, data: betData(r, up, amount) }));
}

/** Claim to the synthetic, then sweep everything it holds back to the Solana wallet. */
export async function solanaClaim(cfg: RomeConfig, wallet: SolanaWallet, janus: Hex, rounds: bigint[], log: StepLog = () => {}) {
  const payer = payerOf(wallet);
  const synthetic = syntheticAddress(payer);
  const deps = laneV1Deps(cfg, wallet.signer);
  log("claim");
  await landed("claim", submitRomeTxV1(deps, { to: janus, data: claimData(rounds) }));
  const amount = await wusdcBalanceOf(cfg, synthetic);
  if (amount === 0n) return;
  log("sweep", "synthetic → wallet");
  const sweep = buildSweepLeg({ programId: cfg.programId, mint: new PublicKey(cfg.usdcMint), amount, wallet: payer, synthetic });
  await submitSolanaInstructionsV1([sweep.ensureWalletAtaIx], { connection: deps.connection, signer: wallet.signer });
  return landed("sweep", submitRomeTxV1(deps, { to: sweep.helperTo, data: sweep.calldata }));
}

/** The PriceBook + Solana source account behind the registry's BTC feed adapter. */
export async function readFeedSource(cfg: RomeConfig): Promise<{ book: Hex; feed: Hex }> {
  const c = publicClient(cfg);
  const [book, feed] = await Promise.all([
    c.readContract({ address: cfg.btcFeedAdapter, abi: BOOK_ADAPTER_ABI, functionName: "book" }),
    c.readContract({ address: cfg.btcFeedAdapter, abi: BOOK_ADAPTER_ABI, functionName: "sourceAccount" }),
  ]);
  return { book: book as Hex, feed: feed as Hex };
}

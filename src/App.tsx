import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, type Hex } from "viem";
import { PublicKey } from "@solana/web3.js";
import type { RomeConfig } from "../lib/config";
import * as rome from "../lib/rome";
import { RoundStatus, type JanusMeta, type Position, type RoundState } from "../lib/rome";
import { connectSolanaWallet, laneWallet, listSolanaWallets, solanaChainId, type Account, type Wallet } from "../lib/solanaWallet";
import configJson from "./config.generated.json";
import "./styles.css";

// Static config projected from the registry at build time (scripts/gen-config.ts).
const cfg = configJson as unknown as RomeConfig;
const JANUS = (configJson as { janus: string | null }).janus as Hex | null;
const HISTORY = 12n; // rounds of history scanned for positions

type Lane = "evm" | "sol";
type Snapshot = {
  now: number;
  round: bigint;
  open: RoundState;
  live: RoundState;
  last: RoundState;
};
type Print = { price: bigint; publishTime: bigint; live: boolean };

const usd = (x: bigint) => Number(formatUnits(x, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const btc = (x: bigint) => (Number(x) / 1e8).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = (s: number) => {
  if (s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const ago = (s: number) => (s < 90 ? `${Math.max(0, Math.round(s))} s ago` : `${Math.round(s / 60)} min ago`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Human message for a failed write: contract errors by name, wallet rejections plainly. */
function explain(e: any): string {
  const msg = String(e?.shortMessage ?? e?.message ?? e);
  const known: Record<string, string> = {
    RoundNotOpenForBets: "This round closed before your bet landed. The next round is open — place it again.",
    BetTooSmall: "That stake is below the round minimum.",
    WrongStatus: "This round has already moved on.",
    NothingToClaim: "Nothing left to claim for these rounds.",
    TransferFailed: "The wUSDC transfer failed. Check your balance and try again.",
  };
  for (const [k, v] of Object.entries(known)) if (msg.includes(k)) return v;
  if (/rejected|denied|cancel/i.test(msg)) return "You declined the request in your wallet. Nothing was sent.";
  if (/0x4\b/.test(msg)) return "The wUSDC wrapper isn't allowed to move your tokens yet. Run the bet again — the grant step will be included.";
  return msg;
}

export default function App() {
  const [meta, setMeta] = useState<JanusMeta>();
  const [snap, setSnap] = useState<Snapshot>();
  const [tick, setTick] = useState(Date.now());

  const [evmAddr, setEvmAddr] = useState<Hex>();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [sol, setSol] = useState<{ wallet: Wallet; account: Account }>();
  const [lane, setLane] = useState<Lane>("evm");

  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState<string>("");
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string }>();
  const [positions, setPositions] = useState<{ r: bigint; lane: Lane; who: Hex; p: Position; rd: RoundState }[]>([]);

  const eth = () => (window as any).ethereum;
  const solPk = useMemo(() => (sol ? new PublicKey(sol.account.publicKey) : undefined), [sol]);
  const synth = solPk ? rome.syntheticFor(solPk) : undefined;

  useEffect(() => listSolanaWallets(cfg.solanaCluster, setWallets), []);
  useEffect(() => {
    if (JANUS) rome.readMeta(cfg, JANUS).then(setMeta).catch((e) => setNote({ kind: "err", text: explain(e) }));
  }, []);
  // The BTC print, read from the registry's feed adapter so it shows even before a contract exists.
  const [src, setSrc] = useState<{ book: Hex; feed: Hex }>();
  const [print, setPrint] = useState<Print>();
  useEffect(() => {
    rome.readFeedSource(cfg).then(setSrc).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!src) return;
    const pull = () => rome.readPrint(cfg, src.book, src.feed).then(setPrint).catch(() => undefined);
    void pull();
    const t = setInterval(pull, 15_000);
    return () => clearInterval(t);
  }, [src]);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!JANUS || !meta) return;
    const now = Math.floor(Date.now() / 1000);
    const round = BigInt(now) < meta.genesis ? 0n : (BigInt(now) - meta.genesis) / meta.interval;
    const at = (r: bigint) => (r < 0n ? Promise.resolve(undefined) : rome.readRound(cfg, JANUS, r));
    const [open, live, last] = await Promise.all([at(round), at(round - 1n), at(round - 2n)]);
    const empty: RoundState = { upPool: 0n, downPool: 0n, strike: 0n, closePrice: 0n, strikeTime: 0n, closeTime: 0n, payoutPool: 0n, status: RoundStatus.Open, upWon: false };
    setSnap({ now, round, open: open ?? empty, live: live ?? empty, last: last ?? empty });

    const ids: { lane: Lane; who: Hex }[] = [];
    if (evmAddr) ids.push({ lane: "evm", who: evmAddr });
    if (synth) ids.push({ lane: "sol", who: synth });
    const from = round > HISTORY ? round - HISTORY : 0n;
    const rounds: bigint[] = [];
    for (let r = round; r >= from; r--) rounds.push(r);
    const found = await Promise.all(
      ids.flatMap((id) =>
        rounds.map(async (r) => {
          const p = await rome.readPosition(cfg, JANUS, r, id.who);
          if (p.up === 0n && p.down === 0n) return null;
          return { r, ...id, p, rd: await rome.readRound(cfg, JANUS, r) };
        }),
      ),
    );
    setPositions(found.filter((x): x is NonNullable<typeof x> => x !== null));
  }, [meta, evmAddr, synth]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function run(label: string, fn: (log: rome.StepLog) => Promise<unknown>, done: string) {
    setBusy(label);
    setNote(undefined);
    try {
      await fn((step, detail) => setBusy(`${label}: ${step}${detail ? ` (${detail})` : ""} — confirm in your wallet`));
      setNote({ kind: "ok", text: done });
      await load();
    } catch (e) {
      setNote({ kind: "err", text: explain(e) });
    } finally {
      setBusy("");
    }
  }

  // MetaMask signs on whatever network it is set to. Rome writes must go to this chain, so
  // switch (or add) it before connecting and again before every write: a wallet left on another
  // chain (e.g. after bridging from Monad testnet) would otherwise sign there or hang.
  const ensureChain = async () => {
    const want = `0x${cfg.chainId.toString(16)}`;
    const have = await eth().request({ method: "eth_chainId" });
    if (String(have).toLowerCase() === want) return;
    try {
      await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } catch (e: any) {
      if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e?.message))) throw e;
      await eth().request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: want,
          chainName: "Rome Hadrian",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [cfg.proxyUrl],
          blockExplorerUrls: [cfg.explorerUrl],
        }],
      });
    }
    const now = await eth().request({ method: "eth_chainId" });
    if (String(now).toLowerCase() !== want) throw new Error(`MetaMask is not on Rome Hadrian (${cfg.chainId}). Switch networks and try again.`);
  };

  const connectEvm = () =>
    run("Connecting MetaMask", async () => {
      if (!eth()) throw new Error("No EVM wallet found. Install MetaMask to use the EVM lane.");
      const [a] = await eth().request({ method: "eth_requestAccounts" });
      await ensureChain();
      setEvmAddr(a);
      setLane("evm");
    }, "MetaMask connected on Rome Hadrian.");
  const connectSol = (w: Wallet) =>
    run(`Connecting ${w.name}`, async () => {
      setSol({ wallet: w, account: await connectSolanaWallet(w) });
      setLane("sol");
    }, `${w.name} connected.`);

  const solWallet = () => laneWallet(sol!.wallet, sol!.account, solanaChainId(cfg.solanaCluster));
  const activeWho = lane === "evm" ? evmAddr : synth;

  const stake = (() => {
    try { return parseUnits(amount || "0", 6); } catch { return 0n; }
  })();

  const placeBet = (up: boolean) => {
    if (!snap || !JANUS) return;
    const r = snap.round;
    const side = up ? "UP" : "DOWN";
    if (lane === "evm") return run(`Betting ${side}`, async (log) => { await ensureChain(); return rome.evmBet(eth(), evmAddr!, cfg, JANUS, r, up, stake, log); }, `Bet placed: ${usd(stake)} wUSDC on ${side} in round ${r}.`);
    return run(`Betting ${side}`, (log) => rome.solanaBet(cfg, solWallet(), JANUS, r, up, stake, log), `Bet placed: ${usd(stake)} USDC on ${side} in round ${r}.`);
  };

  const claimRows = positions.filter((x) => x.p.claimable > 0n);
  const claim = (l: Lane) => {
    const rs = claimRows.filter((x) => x.lane === l).map((x) => x.r);
    if (!rs.length || !JANUS) return;
    if (l === "evm") return run("Claiming", async () => { await ensureChain(); return rome.evmClaim(eth(), evmAddr!, cfg, JANUS, rs); }, "Claimed to your MetaMask wallet.");
    return run("Claiming", (log) => rome.solanaClaim(cfg, solWallet(), JANUS, rs, log), "Claimed and sent back to your Solana wallet.");
  };

  // ── derived view numbers ──
  const now = Math.floor(tick / 1000);
  const interval = meta ? Number(meta.interval) : 1800;
  const lockAt = meta && snap ? Number(meta.genesis) + (Number(snap.round) + 1) * interval : 0;
  const left = lockAt - now;
  const elapsed = snap ? Math.min(1, Math.max(0, 1 - left / interval)) : 0;
  const feeMul = meta ? 1 - meta.feeBps / 10_000 : 0.99;
  /** What a bet on this side would pay right now, or why it can't be quoted yet. */
  const payoutIf = (up: boolean) => {
    if (!snap || stake === 0n) return " ";
    const other = up ? snap.open.downPool : snap.open.upPool;
    if (other === 0n) return `refunded if nobody takes ${up ? "Down" : "Up"}`;
    const pool = Number(snap.open.upPool + snap.open.downPool + stake);
    const side = Number((up ? snap.open.upPool : snap.open.downPool) + stake);
    return `pays ${((pool * feeMul) / side).toFixed(2)}×`;
  };
  const printAge = print ? now - Number(print.publishTime) : undefined;
  const liveLead = snap && print && snap.live.status === RoundStatus.Locked ? (print.price > snap.live.strike ? "UP" : print.price < snap.live.strike ? "DOWN" : "flat") : undefined;
  const canBet = !!activeWho && !!JANUS && !!snap && !busy && stake >= (meta?.minBet ?? 1n) && left > 5;

  return (
    <div className="page">
      <header className="top">
        <div className="mark">
          <span className="mark-word">Janus</span>
          <span className="mark-sub">BTC rounds for both wallets on Rome</span>
        </div>
        <div className="wallets">
          {evmAddr ? (
            <button className={`chip ${lane === "evm" ? "on" : ""}`} onClick={() => setLane("evm")} aria-pressed={lane === "evm"}>
              MetaMask {short(evmAddr)}
            </button>
          ) : (
            <button className="chip" onClick={connectEvm} disabled={!!busy}>Connect MetaMask</button>
          )}
          {solPk ? (
            <button className={`chip ${lane === "sol" ? "on" : ""}`} onClick={() => setLane("sol")} aria-pressed={lane === "sol"}>
              {sol!.wallet.name} {short(solPk.toBase58())}
            </button>
          ) : wallets.length ? (
            wallets.map((w, i) => (
              <button key={`${w.name}-${i}`} className="chip" onClick={() => connectSol(w)} disabled={!!busy}>Connect {w.name}</button>
            ))
          ) : (
            <span className="hint">For the Solana lane, install Solflare (it signs Solana v1 transactions on devnet).</span>
          )}
        </div>
      </header>

      {!JANUS && (
        <p className="setup">No Janus contract is configured. Run <code>npm run deploy</code>, put the address in <code>JANUS_ADDRESS</code>, then restart.</p>
      )}

      <section className="price" aria-live="polite">
        <span className="price-label">BTC</span>
        <span className="price-value">{print ? `$${btc(print.price)}` : <span className="price-wait">loading</span>}</span>
        {printAge !== undefined && <span className="price-age">Pyth print {ago(printAge)}</span>}
      </section>

      <main className="stage">
        <h1 className="sr">Round {snap ? String(snap.round) : ""}: will BTC be higher or lower in {interval / 60} minutes?</h1>
        <div className="coin-wrap">
          <Coin progress={elapsed} />
          <div className="faces">
            <button className="face up" disabled={!canBet} onClick={() => placeBet(true)}>
              <span className="face-word">Up</span>
              <span className="face-pool">{snap ? usd(snap.open.upPool) : "0"} in pool</span>
              <span className="face-pay">{payoutIf(true)}</span>
            </button>
            <div className="axis" aria-hidden />
            <button className="face down" disabled={!canBet} onClick={() => placeBet(false)}>
              <span className="face-word">Down</span>
              <span className="face-pool">{snap ? usd(snap.open.downPool) : "0"} in pool</span>
              <span className="face-pay">{payoutIf(false)}</span>
            </button>
          </div>
        </div>

        <div className="controls">
          <label className="stake">
            <span>Stake</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Stake in USDC" />
            <span>USDC</span>
          </label>
          <p className="window">
            {snap ? <>Round {String(snap.round)} closes for bets in <strong>{clock(left)}</strong>. The strike is the first Pyth print after that.</> : "Loading the current round…"}
          </p>
          {!activeWho && <p className="hint">Connect a wallet to place a bet. Either lane trades the same pool.</p>}
          {activeWho && meta && stake < meta.minBet && <p className="hint">The minimum stake is {usd(meta.minBet)} USDC.</p>}
          {busy && <p className="busy">{busy}…</p>}
          {note && <p className={note.kind === "ok" ? "ok" : "err"} role={note.kind === "err" ? "alert" : undefined}>{note.text}</p>}
        </div>
      </main>

      <section className="strip">
        <div className="slot">
          <h2>{snap && snap.round > 0n ? `Live round ${snap.round - 1n}` : "Live round"}</h2>
          {snap?.live.status === RoundStatus.Locked ? (
            <p>Strike ${btc(snap.live.strike)}. {liveLead === "flat" ? "Level with the strike." : <>Now <b className={liveLead === "UP" ? "t-up" : "t-down"}>{liveLead}</b>.</>} Pool {usd(snap.live.upPool + snap.live.downPool)} USDC.</p>
          ) : snap?.live.status === RoundStatus.Void ? (
            <p>Void — refunds are claimable.</p>
          ) : snap && snap.live.upPool + snap.live.downPool > 0n ? (
            <p>Waiting for the strike print.</p>
          ) : (
            <p className="muted">No bets in this round.</p>
          )}
        </div>
        <div className="slot">
          <h2>{snap && snap.round > 1n ? `Last result, round ${snap.round - 2n}` : "Last result"}</h2>
          {snap?.last.status === RoundStatus.Settled ? (
            <p><b className={snap.last.upWon ? "t-up" : "t-down"}>{snap.last.upWon ? "UP" : "DOWN"}</b> won. ${btc(snap.last.strike)} to ${btc(snap.last.closePrice)}.</p>
          ) : snap?.last.status === RoundStatus.Void ? (
            <p>Void — refunds are claimable.</p>
          ) : snap?.last.status === RoundStatus.Locked ? (
            <p>Settling on the next print.</p>
          ) : (
            <p className="muted">No bets in this round.</p>
          )}
        </div>
      </section>

      <section className="mine">
        <div className="mine-head">
          <h2>Your rounds</h2>
          <div>
            {claimRows.some((x) => x.lane === "evm") && <button className="btn" disabled={!!busy} onClick={() => claim("evm")}>Claim to MetaMask</button>}
            {claimRows.some((x) => x.lane === "sol") && <button className="btn" disabled={!!busy} onClick={() => claim("sol")}>Claim to Solana wallet</button>}
          </div>
        </div>
        {positions.length === 0 ? (
          <p className="muted">Bets you place show up here with their result and what you can claim.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Round</th><th>Wallet</th><th>Up</th><th>Down</th><th>Result</th><th>Claimable</th></tr>
            </thead>
            <tbody>
              {positions.map((x) => (
                <tr key={`${x.lane}-${x.r}`}>
                  <td>{String(x.r)}</td>
                  <td>{x.lane === "evm" ? "MetaMask" : "Solana"}</td>
                  <td>{x.p.up ? usd(x.p.up) : ""}</td>
                  <td>{x.p.down ? usd(x.p.down) : ""}</td>
                  <td>{resultText(x.rd)}</td>
                  <td>{x.p.claimed ? "claimed" : x.p.claimable ? usd(x.p.claimable) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rules">
        <h2>How a round settles</h2>
        <p>Bets close {interval / 60} minutes after a round opens. The strike is the first Pyth BTC price published after that moment, and the close is the first one published {interval / 60} minutes later. The contract pulls both prices from Solana itself, so nobody, including the keeper, can type a price in.</p>
        <p>Winners split the whole pool pro rata, minus a {meta ? meta.feeBps / 100 : 1}% fee. A round is refunded in full if one side has no bets, the price closes exactly flat, or no price arrives within {meta ? Number(meta.tolerance) / 60 : 10} minutes of its target.</p>
        <p className="muted">Testnet only: Rome Hadrian with test USDC. If several prints land inside the {meta ? Number(meta.tolerance) / 60 : 10}-minute window before anyone locks a round, whoever locks it chooses which print counts; a keeper locks on the first one. Source: <a href="https://github.com/Makabeez/janus">github.com/Makabeez/janus</a>.</p>
      </section>

      <footer className="foot">
        {JANUS && <a href={`${cfg.explorerUrl.replace(/\/$/, "")}/address/${JANUS}`} target="_blank" rel="noreferrer">Contract {short(JANUS)} on Via</a>}
        <span>Gas and stakes are USDC. Need test USDC? Use the Rome Bridge to Hadrian.</span>
      </footer>
    </div>
  );
}

function resultText(rd: RoundState) {
  switch (rd.status) {
    case RoundStatus.Settled: return rd.upWon ? "UP won" : "DOWN won";
    case RoundStatus.Void: return "Refunded";
    case RoundStatus.Locked: return "Live";
    default: return "Open";
  }
}

/** The struck coin: a beaded rim whose beads fill as the betting window elapses. */
function Coin({ progress }: { progress: number }) {
  const beads = 60;
  const lit = Math.round(progress * beads);
  const reduce = useRef(typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  return (
    <svg className="coin" viewBox="0 0 400 400" role="img" aria-label={`Betting window ${Math.round(progress * 100)} percent elapsed`}>
      <defs>
        <radialGradient id="metal" cx="42%" cy="36%" r="70%">
          <stop offset="0%" stopColor="#D9AE6E" />
          <stop offset="55%" stopColor="#A9773C" />
          <stop offset="100%" stopColor="#6E4A22" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="196" fill="url(#metal)" />
      <circle cx="200" cy="200" r="172" fill="none" stroke="#5E3F1D" strokeWidth="2" opacity="0.6" />
      {Array.from({ length: beads }, (_, i) => {
        const a = (i / beads) * Math.PI * 2 - Math.PI / 2;
        return (
          <circle
            key={i}
            cx={200 + Math.cos(a) * 184}
            cy={200 + Math.sin(a) * 184}
            r={4.2}
            className={i < lit ? "bead lit" : "bead"}
            style={reduce.current ? { transition: "none" } : undefined}
          />
        );
      })}
    </svg>
  );
}

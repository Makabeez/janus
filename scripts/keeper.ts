// `npm run keeper` — locks and settles Janus rounds as soon as a qualifying Pyth print exists.
// lock/settle are permissionless; this is a convenience so rounds close on the FIRST print after
// their target time (which is what keeps the "caller picks among prints" residual risk small).
//
// Every write is simulated first (eth_call) and only sent when it would succeed: on Rome,
// `submitRomeTx` falls back to a fixed gas ceiling when estimation reverts, so sending a call
// that reverts (e.g. NoPrintYet) would burn gas for nothing. Run under PM2:
//   pm2 start "npm run keeper" --name janus-keeper
import "dotenv/config";
import { encodeFunctionData, type Hex } from "viem";
import { submitRomeTx } from "@rome-protocol/sdk";
import { configFromEnv } from "../lib/config.js";
import { eip1193FromAccount } from "../lib/eip1193Node.js";
import { requireEvmKey } from "../lib/keys.js";
import { JANUS_ABI, RoundStatus, publicClient, readMeta, readRound } from "../lib/rome.js";

const cfg = configFromEnv();
const janus = process.env.JANUS_ADDRESS as Hex | undefined;
if (!janus || !/^0x[0-9a-fA-F]{40}$/.test(janus)) {
  console.error("JANUS_ADDRESS is not set — run `npm run deploy` first.");
  process.exit(1);
}
const account = requireEvmKey();
const provider = eip1193FromAccount(account, cfg.proxyUrl, cfg.chainId);
const pub = publicClient(cfg);
const POLL_MS = Number(process.env.KEEPER_POLL_MS || 20_000);
const LOOKBACK = 4n; // rounds behind the current one to re-check

const ts = () => new Date().toISOString();
const log = (...a: unknown[]) => console.log(ts(), ...a);

async function trySend(fn: "lock" | "settle", r: bigint): Promise<boolean> {
  const data = encodeFunctionData({ abi: JANUS_ABI, functionName: fn, args: [r] });
  try {
    await pub.call({ account: account.address, to: janus!, data });
  } catch (e: any) {
    const sel = (String(e?.message).match(/0x[0-9a-f]{8}/) || ["?"])[0];
    log(`${fn}(${r}) not ready (sim revert ${sel})`);
    return false;
  }
  const hash = await submitRomeTx(provider, { from: account.address, to: janus!, data });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  log(`${fn}(${r}) → ${rcpt.status} ${hash}`);
  return rcpt.status === "success";
}

async function tick(meta: Awaited<ReturnType<typeof readMeta>>) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < meta.genesis) return;
  const cur = (now - meta.genesis) / meta.interval;
  const from = cur > LOOKBACK ? cur - LOOKBACK : 0n;
  for (let r = from; r < cur; r++) {
    const rd = await readRound(cfg, janus!, r);
    const lockAt = meta.genesis + (r + 1n) * meta.interval;
    const expiry = lockAt + meta.interval;
    if (rd.status === RoundStatus.Open && now >= lockAt) {
      if (rd.upPool + rd.downPool === 0n) continue; // nobody to lock or refund
      await trySend("lock", r);
    } else if (rd.status === RoundStatus.Locked && now >= expiry) {
      await trySend("settle", r);
    }
  }
}

const meta = await readMeta(cfg, janus);
log(`keeper up | janus ${janus} | interval ${meta.interval}s tol ${meta.tolerance}s | keeper ${account.address}`);
for (;;) {
  try {
    await tick(meta);
  } catch (e: any) {
    log("tick error:", e?.shortMessage ?? e?.message ?? e);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

<div align="center">

<img src="assets/banner.svg" alt="Janus" width="100%" />

**BTC UP/DOWN rounds on Rome. A MetaMask wallet and a Solana wallet bet into the same pool, priced by Pyth on Solana.**

[![Live demo](https://img.shields.io/badge/Live_demo-janus--sepia--nine.vercel.app-C2924F?style=for-the-badge)](https://janus-sepia-nine.vercel.app)
[![Contract](https://img.shields.io/badge/Contract-0x6ba4…4108-5BC0A0?style=for-the-badge)](https://via-hadrian.testnet.romeprotocol.xyz/address/0x6ba430e36fa83955ef94845ea0dcadb28af84108)
[![Demo video](https://img.shields.io/badge/Demo-62s_video-C9543F?style=for-the-badge&logo=youtube&logoColor=white)](https://youtu.be/1scqc4JvXPk)
[![Built on Rome](https://img.shields.io/badge/Built_on-Rome-14302A?style=for-the-badge)](https://docs.rome.builders)
[![License: MIT](https://img.shields.io/badge/License-MIT-EAE3CF?style=for-the-badge)](LICENSE)

![Solidity](https://img.shields.io/badge/Solidity-0.8.26-363636?logo=solidity)
![Tests](https://img.shields.io/badge/tests-13_passing-5BC0A0)
![Two-wallet round](https://img.shields.io/badge/two--wallet_round-live_on_Hadrian-C2924F)
![Pyth](https://img.shields.io/badge/oracle-Pyth_via_Oracle_Gateway-8DA59C)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)

</div>

> Rome's Arena lists a "BTC Options Platform" as an idea worth building: *an options app on Rome with USDC settlement and a Bitcoin price feed, where EVM and Solana wallets use the same contracts.* Janus is that, in its simplest honest form: pari-mutuel binary rounds, no market maker, no pricing model, and a price the contract fetches from Solana itself.

## Why

Every prediction app on one chain splits its liquidity from every app on the other. On Rome a Solana user signs with their Solana key and acts as a Rome-derived synthetic address, so **one Solidity contract has one pool that both wallet types trade against**. Janus makes that visible: you can be on the UP side from MetaMask while your counterparty is on DOWN from Solflare.

The second point is price integrity on a testnet oracle that is mostly broken (see [Measured](#measured-not-asserted)). Janus never trusts a stored price: `lock` and `settle` call the PriceBook's permissionless `refreshAll`, which pulls the Pyth `PriceUpdateV2` account from Solana inside the same transaction, and accept only a print published inside a fixed window after the target time.

## Architecture

```
 MetaMask (EVM key)                      Solflare (Solana key, no EVM key)
        │ submitRomeTx                            │ submitRomeTxV1 (one Solana v1 tx per call)
        ▼                                         ▼
 ┌──────────────────────── Rome Hadrian (EVM inside a Solana program) ─────────────────┐
 │                                                                                      │
 │   wUSDC (SPL USDC as ERC-20) ──► Janus.sol ── bet / lock / settle / claim            │
 │                                     │                                                │
 │                                     │ refreshAll([BTC source])  +  entryOf()         │
 │                                     ▼                                                │
 │                           Oracle Gateway PriceBook ──(account read)──┐               │
 └──────────────────────────────────────────────────────────────────────┼──────────────┘
                                                                        ▼
                                              Solana devnet: Pyth BTC/USD PriceUpdateV2
                                              (4cSM2e6r…PSPo, ~5-min cadence measured)
        ▲
 keeper (scripts/keeper.ts, PM2) — simulates, then calls lock/settle on the first print
```

## Tech stack

| Layer | What |
| --- | --- |
| Contract | `contracts/Janus.sol` — Solidity 0.8.26, no dependencies |
| Price | Rome Oracle Gateway `PriceBook` (BTC/USD-BOOK) → Pyth pull account on Solana devnet |
| Token | wUSDC (Circle devnet USDC surfaced as ERC-20 by Rome's SPL wrapper) |
| Wallet lanes | `@rome-protocol/sdk` v0.4.0 — `submitRomeTx` (EVM); `submitRomeTxSolanaLane` for Solana wallets that sign legacy txs, `submitRomeTxV1` otherwise |
| Config | `@rome-protocol/registry` v0.3.0 — chain, wUSDC, feed adapter; nothing hardcoded |
| Frontend | React 18 + Vite, Wallet Standard for any Solana wallet |
| Tests | Hardhat + chai, mocks for the token and the PriceBook |

## Flow

1. **Bet.** Round `r` takes bets for `interval` seconds (default 30 min). The tx must name `r`; if it lands after the window it reverts instead of silently entering the next round.
2. **Lock.** At `lockAt(r)` anyone may call `lock(r)`. The contract refreshes the PriceBook and requires a print with `publishTime ∈ [lockAt, lockAt + tolerance]`. That print is the strike. Bettors never see the strike before betting closes.
3. **Settle.** At `expiryAt(r) = lockAt(r) + interval` the same rule picks the close. UP wins if `close > strike`, DOWN if `close < strike`.
4. **Claim.** Winners split `pool × (1 − fee)` pro rata. A Solana user's claim lands on their synthetic address and the app sweeps it straight back to the wallet.
5. **Void.** One-sided round, flat close, or no qualifying print within `tolerance`: the round is void and every stake is refundable. No fee is taken on a void round.

## Smart contract

```solidity
function lock(uint256 r) external nonReentrant {
    ...
    if (block.timestamp > uint256(target) + tolerance) return _void(r, "no strike print in window");
    if (rd.upPool == 0 || rd.downPool == 0) return _void(r, "one-sided round");
    (int64 price, uint64 pt) = _freshPrint();   // refreshAll() then entryOf()
    if (pt < target) revert NoPrintYet(pt, target);
    ...
}
```

The PriceBook keeps only its latest print and never accepts a future one, so `pt ≤ block.timestamp ≤ target + tolerance` holds for anything `lock` accepts.

## Measured, not asserted

Everything below was measured on Hadrian / Solana devnet on 4 Nov 2026. None of it is taken from docs.

| Fact | Result | How |
| --- | --- | --- |
| Plain Oracle Gateway feeds (`BTC/USD`, `SOL/USD`, … 10 feeds) | all revert `StalePriceFeed()` — their `maxStaleness` is 60 s, a fifth of the publish cadence | `latestRoundData()` on every registry feed |
| `-CACHED` / `-CACHEDPYTH` feeds (20 feeds) | all revert `UninitializedPriceFeed()` | same sweep |
| `-BOOK` feeds (9 live) | serve prices (BTC ≈ $80,1xx) | same sweep |
| PriceBook `refreshAll` from an EVM call | commits (`[1,0,0]`) | `eth_call` against the live book |
| Pyth devnet BTC publish cadence | 6 prints, 21:31:42 → 21:57:11 UTC, every ≈ 306 s | 15-s poll of the Solana account |
| Deploy cost (7,530-byte contract) | 45,186,201 gas; charged at the full `maxFeePerGas` (effective 192.88 gwei = max fee) | receipt of the deploy tx |
| Drift v2 devnet perp markets | last activity: BTC/ETH May 2026, SOL Oct 12 | `getSignaturesForAddress` on each market PDA |

The cadence is why the default `tolerance` is 10 minutes: the window always contains at least one print and at most two.

## Real vs simulated

| | Status |
| --- | --- |
| Contract logic | Real — 13 Hardhat tests, mocked token + book |
| PriceBook refresh path | Real (simulated call against the live Hadrian book) |
| Hadrian deployment | Real — [`0x6ba4…4108`](https://via-hadrian.testnet.romeprotocol.xyz/address/0x6ba430e36fa83955ef94845ea0dcadb28af84108), [deploy tx](https://via-hadrian.testnet.romeprotocol.xyz/tx/0xedf1821e805c743ab6613c74b09df7f71826088901cb89180886c9757898b4fe) |
| Frontend | Real — [janus-sepia-nine.vercel.app](https://janus-sepia-nine.vercel.app), reads the deployed contract and the live PriceBook |
| Both-lane bet into one round | Real — round 45: MetaMask UP 1 USDC + Solflare DOWN 1 USDC, same pool ([proof](#first-two-wallet-round)) |
| Void + refund + claim | Real — rounds 0 and 42 voided as one-sided by the keeper; refund claimed back to MetaMask |
| Money | Test USDC only. Hadrian settles on Solana devnet. |

## First two-wallet round

Watch it: [62-second demo](https://youtu.be/1scqc4JvXPk) (MetaMask claims a refund and bets Up, Solflare bets Down, both shown on Rome's explorer).

Round 45, 5 Nov 2026, 22:00–22:30 UTC. One Janus pool, two wallet types, no bridge in between.

| Step | Wallet | Tx |
| --- | --- | --- |
| Bet UP 1 USDC | MetaMask (EVM key) | [`0x7936…fe27`](https://via-hadrian.testnet.romeprotocol.xyz/tx/0x79366daaf1ae5b5c435b1042b4213c27040e6d3f04048c802c05d5210e76fe27) |
| Wrapper grant (one-time) | Solflare (Solana key, no EVM key) | [`3idK…oQPj`](https://explorer.solana.com/tx/3idKF17NpHnRjKajJM67BqMwoevxrvHXMVXXjUZtJr5DAZGLBdWu7efs3bEYUPMboY2r49PiPmucXPeHyf1YoQPj?cluster=devnet) |
| Fund leg: USDC → Rome address | Solflare | [`n4TU…Stn7p`](https://explorer.solana.com/tx/n4TUJssEbkLUCg8k2HwhvHBxXkSuQ37cJ2JrGFPhu51fYHwFR1mN3bZ9kuf3G37i3TahPAUsB57yNmWiBSStn7p?cluster=devnet) |
| Bet DOWN 1 USDC | Solflare | [`E9ve…gXp`](https://explorer.solana.com/tx/E9veuQRqebjfN9zgFpXo8MXBMzhvnWnhCiFw8qKkmmpbb3znt3Ns9EsbSHmvBdPfoTNsnMAtX8SHqBhfTUSJgXp?cluster=devnet) · EVM view [`0x5467…d31f`](https://via-hadrian.testnet.romeprotocol.xyz/tx/0x5467a3969b60aab02f8eeff118834aa787c7fc06b5c309b661718b08a35ad31f) |

Earlier rounds exercised the failure paths for real: round 42 had only an UP bet, the keeper voided it ([`0x55d7…b5bc`](https://via-hadrian.testnet.romeprotocol.xyz/tx/0x55d7e5f238a5fd8791e4f72d0987ad0b63fde7e99439ae07b7f60ff756dbb5bc)), and the stake was claimed back to MetaMask ([`0xcb95…02ef`](https://via-hadrian.testnet.romeprotocol.xyz/tx/0xcb95679081e16a6fa38645d42cbfae8a659ead3301541445a0627dfa96f602ef)).

### What it took on the Solana side

Solflare prepends its own `SetComputeUnitPrice` instruction to every transaction it can simulate. On the v1 lane the SDK compares the signed bytes with the composed ones and refuses to broadcast ("the wallet signed a different transaction than the one composed") — correctly, since a v1 signature covers the exact message. Janus therefore sends a Solana wallet's Rome calls through the SDK's legacy lane (`submitRomeTxSolanaLane`, `DoTxUnsigned`), where the Solana signature itself authorizes the call and a wallet-added fee instruction keeps the transaction valid. Measured on devnet before switching: the grant simulated OK both as composed and with a prepended fee instruction; bet/claim/sweep fit in 859/694/692 of 1232 bytes; an EVM revert fails the Solana transaction (`AtomicTxFailed`) instead of landing as a silent revert. The fund leg and ATA creation carry no Rome authorization and go out as ordinary wallet-signed transactions.

## Honest limits

- **Print choice inside the window.** If two prints land in `[T, T + tolerance]` before anyone locks, the caller picks which one counts. The keeper locks on the first one; a bettor running their own locker could pick between at most two (measured cadence). A history-aware oracle would close this.
- **Testnet oracle health.** If Pyth devnet stops publishing, rounds void and refund. Nobody loses a stake, but nobody wins either.
- **Pari-mutuel, not options pricing.** Payout depends on the pool split, not on a model. That's deliberate for a first version: there is no LP that can be drained.
- **Unaudited.** Testnet only.

## Local development

```bash
npm install
cp .env.example .env          # ROME_EVM_KEY = a TESTNET-only key with ~10 USDC of Hadrian gas
npm test                      # contract tests
npm run deploy                # prints JANUS_ADDRESS
npm run keeper                # lock/settle loop (run it under PM2)
npm run demo                  # MetaMask key bets UP, Solana key bets DOWN, same round
npm run dev                   # the app
```

Fund Hadrian gas with the [Rome Bridge](https://bridge-api.devnet.romeprotocol.xyz/?chain=200010) from Circle's faucet USDC. There is no Rome faucet. The Solana lane needs a wallet that signs Solana v1 transactions; on devnet that is Solflare.

## Deployment

| | |
| --- | --- |
| Chain | Rome Hadrian, chain id 200010 |
| Janus | [`0x6ba430e36fa83955ef94845ea0dcadb28af84108`](https://via-hadrian.testnet.romeprotocol.xyz/address/0x6ba430e36fa83955ef94845ea0dcadb28af84108) |
| Explorer | [Via](https://via-hadrian.testnet.romeprotocol.xyz/) |
| App | [janus-sepia-nine.vercel.app](https://janus-sepia-nine.vercel.app) |

## Attribution

Scaffolded from [create-rome-app](https://github.com/rome-protocol/create-rome-app) (MIT, Rome Protocol); the two-lane helpers in `lib/` follow its patterns. `AGENTS.md` is Rome's canonical agent guide, kept as shipped.

## License

[MIT](LICENSE)

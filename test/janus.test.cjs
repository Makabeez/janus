// Janus unit tests (Hardhat + ethers v6). Run: npm test  (see test/README in repo root)
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const I = 3600; // interval
const TOL = 900; // tolerance
const MIN = 100_000n; // 0.1 wUSDC
const FEE = 100; // 1%
const usd = (x) => BigInt(Math.round(x * 1e6));
const px = (x) => BigInt(Math.round(x * 1e8));

async function setTime(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
  await network.provider.send("evm_mine");
}
async function nextTxAt(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
}

describe("Janus", () => {
  let token, book, janus, owner, alice, bob, carol, treasury, genesis;

  beforeEach(async () => {
    [owner, alice, bob, carol, treasury] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockToken")).deploy();
    book = await (await ethers.getContractFactory("MockBook")).deploy();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    genesis = BigInt(Math.ceil((now + 10) / I) * I);
    janus = await (await ethers.getContractFactory("Janus")).deploy(
      await token.getAddress(), await book.getAddress(), ethers.ZeroHash, genesis, I, TOL, MIN, FEE, treasury.address,
    );
    for (const u of [alice, bob, carol]) {
      await token.mint(u.address, usd(1000));
      await token.connect(u).approve(await janus.getAddress(), ethers.MaxUint256);
    }
    await setTime(genesis + 10n);
  });

  const lockT = () => genesis + BigInt(I);
  const expT = () => genesis + BigInt(2 * I);

  it("rejects bad config", async () => {
    const F = await ethers.getContractFactory("Janus");
    const a = await token.getAddress(), b = await book.getAddress();
    await expect(F.deploy(a, b, ethers.ZeroHash, genesis, I, I, MIN, FEE, treasury.address)).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(F.deploy(a, b, ethers.ZeroHash, genesis, I, TOL, MIN, 2000, treasury.address)).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(F.deploy(a, b, ethers.ZeroHash, genesis, I, TOL, MIN, FEE, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "BadConfig");
  });

  it("full round: UP wins, pro-rata payout, 1% fee to treasury", async () => {
    await janus.connect(alice).bet(0, true, usd(30));
    await janus.connect(carol).bet(0, true, usd(10));
    await janus.connect(bob).bet(0, false, usd(60));

    await book.stage(px(80000), lockT() + 60n);
    await nextTxAt(lockT() + 120n);
    await expect(janus.lock(0)).to.emit(janus, "RoundLocked").withArgs(0, px(80000), lockT() + 60n);

    await book.stage(px(80500), expT() + 30n);
    await nextTxAt(expT() + 90n);
    await expect(janus.settle(0)).to.emit(janus, "RoundSettled");

    expect(await token.balanceOf(treasury.address)).to.equal(usd(1)); // 1% of 100
    // payout pool 99; alice 30/40, carol 10/40
    expect(await janus.claimable(0, alice.address)).to.equal(usd(74.25));
    expect(await janus.claimable(0, carol.address)).to.equal(usd(24.75));
    expect(await janus.claimable(0, bob.address)).to.equal(0n);

    const before = await token.balanceOf(alice.address);
    await janus.connect(alice).claim([0]);
    expect((await token.balanceOf(alice.address)) - before).to.equal(usd(74.25));
    await expect(janus.connect(alice).claim([0])).to.be.revertedWithCustomError(janus, "NothingToClaim");
    await expect(janus.connect(bob).claim([0])).to.be.revertedWithCustomError(janus, "NothingToClaim");
  });

  it("DOWN wins when close < strike", async () => {
    await janus.connect(alice).bet(0, true, usd(10));
    await janus.connect(bob).bet(0, false, usd(10));
    await book.stage(px(80000), lockT() + 1n);
    await nextTxAt(lockT() + 5n);
    await janus.lock(0);
    await book.stage(px(79999.99), expT() + 1n);
    await nextTxAt(expT() + 5n);
    await janus.settle(0);
    expect((await janus.getRound(0)).upWon).to.equal(false);
    expect(await janus.claimable(0, bob.address)).to.equal(usd(19.8));
  });

  it("only the current round accepts bets, and only above minBet", async () => {
    await expect(janus.connect(alice).bet(1, true, usd(1))).to.be.revertedWithCustomError(janus, "RoundNotOpenForBets");
    await expect(janus.connect(alice).bet(0, true, MIN - 1n)).to.be.revertedWithCustomError(janus, "BetTooSmall");
    await expect(janus.connect(alice).bet(0, true, 2n ** 64n)).to.be.revertedWithCustomError(janus, "BetTooLarge");
    await setTime(lockT());
    await expect(janus.connect(alice).bet(0, true, usd(1))).to.be.revertedWithCustomError(janus, "RoundNotOpenForBets");
    await janus.connect(alice).bet(1, true, usd(1)); // next round is open now
  });

  it("lock: too early reverts; a pre-lock print never becomes the strike", async () => {
    await janus.connect(alice).bet(0, true, usd(5));
    await janus.connect(bob).bet(0, false, usd(5));
    await expect(janus.lock(0)).to.be.revertedWithCustomError(janus, "TooEarly");

    // The book only has a print from BEFORE lockAt -> must not lock on it.
    await book.commit(px(80000), lockT() - 30n);
    await nextTxAt(lockT() + 10n);
    await expect(janus.lock(0)).to.be.revertedWithCustomError(janus, "NoPrintYet");

    // A fresh print arrives on the Solana side; lock() pulls it in itself.
    await book.stage(px(80100), lockT() + 200n);
    await nextTxAt(lockT() + 210n);
    await janus.lock(0);
    const r = await janus.getRound(0);
    expect(r.strike).to.equal(px(80100));
    expect(r.strikeTime).to.equal(lockT() + 200n);
  });

  it("refresh faults are tolerated: lock still uses an already-committed qualifying print", async () => {
    await janus.connect(alice).bet(0, true, usd(5));
    await janus.connect(bob).bet(0, false, usd(5));
    await book.commit(px(80000), lockT() + 5n); // someone else refreshed the book
    await book.setRefreshReverts(true);
    await nextTxAt(lockT() + 20n);
    await janus.lock(0);
    expect((await janus.getRound(0)).status).to.equal(1n);
  });

  it("paused or uninitialized book entry counts as no print", async () => {
    await janus.connect(alice).bet(0, true, usd(5));
    await janus.connect(bob).bet(0, false, usd(5));
    await book.commit(px(80000), lockT() + 5n);
    await book.setStatus(2);
    await nextTxAt(lockT() + 20n);
    await expect(janus.lock(0)).to.be.revertedWithCustomError(janus, "NoPrintYet");
  });

  it("one-sided round is void and refunded at lock", async () => {
    await janus.connect(alice).bet(0, true, usd(7));
    await nextTxAt(lockT() + 1n);
    await expect(janus.lock(0)).to.emit(janus, "RoundVoided").withArgs(0, "one-sided round");
    expect(await janus.claimable(0, alice.address)).to.equal(usd(7));
    await janus.connect(alice).claim([0]);
    expect(await token.balanceOf(alice.address)).to.equal(usd(1000));
  });

  it("no strike print within tolerance -> void (via lock or voidRound), full refunds", async () => {
    await janus.connect(alice).bet(0, true, usd(5));
    await janus.connect(bob).bet(0, false, usd(8));
    await expect(janus.voidRound(0)).to.be.revertedWithCustomError(janus, "WrongStatus");
    await nextTxAt(lockT() + BigInt(TOL) + 1n);
    await expect(janus.lock(0)).to.emit(janus, "RoundVoided").withArgs(0, "no strike print in window");
    expect(await janus.claimable(0, bob.address)).to.equal(usd(8));
    await expect(janus.lock(0)).to.be.revertedWithCustomError(janus, "WrongStatus");
  });

  it("no close print within tolerance -> void, fee never taken", async () => {
    await janus.connect(alice).bet(0, true, usd(5));
    await janus.connect(bob).bet(0, false, usd(5));
    await book.stage(px(80000), lockT() + 1n);
    await nextTxAt(lockT() + 2n);
    await janus.lock(0);
    await expect(janus.settle(0)).to.be.revertedWithCustomError(janus, "TooEarly");
    await nextTxAt(expT() + 10n);
    await expect(janus.settle(0)).to.be.revertedWithCustomError(janus, "NoPrintYet"); // book still at strike print
    await nextTxAt(expT() + BigInt(TOL) + 1n);
    await janus.voidRound(0);
    expect(await token.balanceOf(treasury.address)).to.equal(0n);
    expect(await janus.claimable(0, alice.address)).to.equal(usd(5));
  });

  it("flat close is void", async () => {
    await janus.connect(alice).bet(0, true, usd(5));
    await janus.connect(bob).bet(0, false, usd(5));
    await book.stage(px(80000), lockT() + 1n);
    await nextTxAt(lockT() + 2n);
    await janus.lock(0);
    await book.stage(px(80000), expT() + 1n);
    await nextTxAt(expT() + 2n);
    await expect(janus.settle(0)).to.emit(janus, "RoundVoided").withArgs(0, "flat close");
  });

  it("batch claim across settled + void rounds; both sides of one round", async () => {
    // round 0: alice bets both sides, bob down
    await janus.connect(alice).bet(0, true, usd(10));
    await janus.connect(alice).bet(0, false, usd(10));
    await janus.connect(bob).bet(0, false, usd(20));
    await book.stage(px(80000), lockT() + 1n);
    await nextTxAt(lockT() + 2n);
    await janus.lock(0);
    // round 1 (now open): one-sided -> void
    await janus.connect(alice).bet(1, true, usd(3));
    await book.stage(px(81000), expT() + 1n);
    await nextTxAt(expT() + 2n);
    await janus.settle(0); // UP wins round 0: pool 40, payout 39.6 all to alice's 10 up
    await nextTxAt(expT() + 3n);
    await janus.lock(1); // one-sided -> void

    const before = await token.balanceOf(alice.address);
    await janus.connect(alice).claim([0, 1, 5]);
    expect((await token.balanceOf(alice.address)) - before).to.equal(usd(39.6) + usd(3));
  });

  it("contract balance covers every claim (no insolvency from rounding)", async () => {
    const stakes = [usd(1.111111), usd(2.333333), usd(0.777777)];
    await janus.connect(alice).bet(0, true, stakes[0]);
    await janus.connect(carol).bet(0, true, stakes[1]);
    await janus.connect(bob).bet(0, false, stakes[2]);
    await book.stage(px(80000), lockT() + 1n);
    await nextTxAt(lockT() + 2n);
    await janus.lock(0);
    await book.stage(px(80001), expT() + 1n);
    await nextTxAt(expT() + 2n);
    await janus.settle(0);
    await janus.connect(alice).claim([0]);
    await janus.connect(carol).claim([0]); // would revert ("bal") if payouts exceeded the pool
    const left = await token.balanceOf(await janus.getAddress());
    expect(left >= 0n && left <= 2n).to.equal(true); // only rounding dust remains
  });
});

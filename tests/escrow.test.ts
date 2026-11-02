/**
 * Local tests for offchange_escrow, run in-process with LiteSVM (no network,
 * no SOL). Runs the whole flow twice: SPL Token and Token-2022.
 *   npm test
 */
import { readFileSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as E from "../client/escrow";

const SO = "target/deploy/offchange_escrow.so";
const FEE_BPS = 50;
const DEC = 6;
const T = (n: number) => BigInt(n) * 10n ** BigInt(DEC); // whole tokens → base units

let passed = 0;
const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`✗ ${what}`);
  passed++;
  console.log(`  ✓ ${what}`);
};

function run(tokenProgram: PublicKey, label: string) {
  console.log(`\n${label}`);
  const svm = new LiteSVM();
  svm.addProgram(E.PROGRAM_ID, readFileSync(SO));

  const [admin, matcher, fee, seller, sellerFresh, buyer, buyerStealth, maker2, maker2Stealth, taker3, stranger, fakeMatcher, mintKp] =
    Array.from({ length: 13 }, () => Keypair.generate());
  for (const k of [admin, matcher, fee, seller, buyer, maker2, taker3, stranger, fakeMatcher]) svm.airdrop(k.publicKey, 10n * BigInt(LAMPORTS_PER_SOL));
  const mint = mintKp.publicKey;

  const send = (signers: Keypair[], ...ixs: TransactionInstruction[]) => {
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    const res = svm.sendTransaction(tx);
    svm.expireBlockhash();
    return res;
  };
  const sendOk = (signers: Keypair[], ...ixs: TransactionInstruction[]) => {
    const res = send(signers, ...ixs);
    if (res instanceof FailedTransactionMetadata) {
      console.log(res.meta().logs().join("\n"));
      throw new Error(`tx failed: ${JSON.stringify(res.err())}`);
    }
    return res;
  };
  const fails = (signers: Keypair[], ...ixs: TransactionInstruction[]) => {
    try {
      return send(signers, ...ixs) instanceof FailedTransactionMetadata;
    } catch {
      return true; // rejected before execution (e.g. missing signature)
    }
  };
  const bal = (k: PublicKey) => svm.getBalance(k) ?? 0n;
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const tokens = (acct: PublicKey) => {
    const a = svm.getAccount(acct);
    return a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
  };
  const order = (k: PublicKey) => {
    const a = svm.getAccount(k);
    return a && a.data.length ? E.decodeOrder(a.data) : null;
  };
  const mkAta = (payer: Keypair, owner: PublicKey) =>
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(owner), owner, mint, tokenProgram);

  // a coin: 1,000,000 supply, seller and taker3 hold some
  sendOk(
    [admin, mintKp],
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: mint,
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
      space: MINT_SIZE,
      programId: tokenProgram,
    }),
    createInitializeMint2Instruction(mint, DEC, admin.publicKey, null, tokenProgram),
    mkAta(admin, seller.publicKey),
    mkAta(admin, taker3.publicKey),
    createMintToInstruction(mint, ata(seller.publicKey), admin.publicKey, T(10_000), [], tokenProgram),
    createMintToInstruction(mint, ata(taker3.publicKey), admin.publicKey, T(2_000), [], tokenProgram),
  );

  // ---- config
  sendOk([admin], E.initConfig({ admin: admin.publicKey, matcher: matcher.publicKey, feeWallet: fee.publicKey, feeBps: FEE_BPS }));
  const cfg = E.decodeConfig(svm.getAccount(E.configPda())!.data);
  ok(cfg.matcher.equals(matcher.publicKey) && cfg.feeBps === FEE_BPS && !cfg.paused, "config set: matcher, 0.5% fee, live");
  ok(fails([stranger], E.setConfig({ admin: stranger.publicKey, newAdmin: stranger.publicKey, matcher: stranger.publicKey, feeWallet: stranger.publicKey, feeBps: 0, paused: false })), "a stranger cannot take over the config");

  // ---- a hidden sell order: 1,000 tokens at 50,000 lamports per token
  const sellPrice = 50_000n;
  const sellSalt = E.randomSalt();
  const sellNonce = 1n;
  const sellOrder = E.orderPda(seller.publicKey, sellNonce);
  const sellerBefore = tokens(ata(seller.publicKey));
  sendOk(
    [seller],
    E.openSell({
      maker: seller.publicKey,
      mint,
      makerAta: ata(seller.publicKey),
      tokenProgram,
      nonce: sellNonce,
      amount: T(1_000),
      commitment: E.commitment(sellPrice, sellerFresh.publicKey, sellSalt),
    }),
  );
  ok(tokens(E.vaultPda(sellOrder)) === T(1_000) && tokens(ata(seller.publicKey)) === sellerBefore - T(1_000), "open_sell: 1,000 tokens moved into the order's vault");
  const o1 = order(sellOrder)!;
  ok(o1.side === E.SIDE_SELL && o1.left === T(1_000), "order on chain stores size, not price or payout");

  // ---- a buyer takes 400 at the committed price
  const reveal = { price: sellPrice, payout: sellerFresh.publicKey, salt: sellSalt };
  const fillArgs = {
    taker: buyer.publicKey,
    matcher: matcher.publicKey,
    feeWallet: fee.publicKey,
    maker: seller.publicKey,
    mint,
    order: sellOrder,
    takerDest: ata(buyerStealth.publicKey),
    tokenProgram,
    amount: T(400),
    reveal,
  };
  ok(fails([buyer, matcher], mkAta(buyer, buyerStealth.publicKey), E.fillSell({ ...fillArgs, reveal: { ...reveal, price: 1n } })), "fill_sell with a fake low price is refused");
  ok(fails([buyer, matcher], mkAta(buyer, buyerStealth.publicKey), E.fillSell({ ...fillArgs, reveal: { ...reveal, payout: buyer.publicKey } })), "fill_sell paying a different wallet is refused");
  ok(fails([buyer, fakeMatcher], mkAta(buyer, buyerStealth.publicKey), E.fillSell({ ...fillArgs, matcher: fakeMatcher.publicKey })), "fill_sell signed by a fake matcher is refused");
  ok(fails([buyer], mkAta(buyer, buyerStealth.publicKey), E.fillSell(fillArgs)), "fill_sell without the matcher's signature is refused");
  ok(fails([buyer, matcher], mkAta(buyer, buyerStealth.publicKey), E.fillSell({ ...fillArgs, amount: T(1_001) })), "fill_sell above what is left is refused");

  const cost = E.costCeil(T(400), sellPrice);
  const feeAmt = E.feeOf(cost, FEE_BPS);
  const feeBefore = bal(fee.publicKey);
  sendOk([buyer, matcher], mkAta(buyer, buyerStealth.publicKey), E.fillSell(fillArgs));
  ok(tokens(ata(buyerStealth.publicKey)) === T(400), "fill_sell: 400 tokens reached the buyer's stealth wallet");
  ok(bal(sellerFresh.publicKey) === cost - feeAmt, `fill_sell: seller's fresh wallet got ${cost - feeAmt} lamports`);
  ok(bal(fee.publicKey) - feeBefore === feeAmt, `fill_sell: fee wallet got ${feeAmt} lamports (0.5%)`);
  ok(order(sellOrder)!.left === T(600), "fill_sell: order shows 600 left");

  // ---- a resting buy order at a higher price, then a cross between the two
  const buyPrice = 60_000n;
  const buySalt = E.randomSalt();
  const buyNonce = 7n;
  const buyOrder = E.orderPda(maker2.publicKey, buyNonce);
  const escrow = 2n * BigInt(LAMPORTS_PER_SOL) / 100n; // 0.02 SOL
  const buyRentBefore = bal(maker2.publicKey);
  sendOk([maker2], E.openBuy({ maker: maker2.publicKey, mint, nonce: buyNonce, lamports: escrow, commitment: E.commitment(buyPrice, maker2Stealth.publicKey, buySalt) }));
  ok(order(buyOrder)!.left === escrow && buyRentBefore - bal(maker2.publicKey) > escrow, "open_buy: 0.02 SOL escrowed in the order");

  const crossArgs = {
    matcher: matcher.publicKey,
    feeWallet: fee.publicKey,
    mint,
    sellOrder,
    sellMaker: seller.publicKey,
    buyOrder,
    buyMaker: maker2.publicKey,
    buyPayoutDest: ata(maker2Stealth.publicKey),
    tokenProgram,
    amount: T(300),
    sell: reveal,
    buy: { price: buyPrice, payout: maker2Stealth.publicKey, salt: buySalt },
  };
  ok(fails([matcher], mkAta(matcher, maker2Stealth.publicKey), E.cross({ ...crossArgs, buy: { ...crossArgs.buy, price: 40_000n } })), "cross refused when the revealed prices don't meet");
  const mid = (sellPrice + buyPrice) / 2n;
  const crossCost = E.costFloor(T(300), mid);
  const crossFee = E.feeOf(crossCost, FEE_BPS);
  const freshBefore = bal(sellerFresh.publicKey);
  sendOk([matcher], mkAta(matcher, maker2Stealth.publicKey), E.cross(crossArgs));
  ok(tokens(ata(maker2Stealth.publicKey)) === T(300), "cross: 300 tokens to the buyer's stealth wallet, nobody else signed");
  ok(bal(sellerFresh.publicKey) - freshBefore === crossCost - crossFee, `cross: seller paid at the midpoint (${mid} per token)`);
  ok(order(sellOrder)!.left === T(300) && order(buyOrder)!.left === escrow - crossCost, "cross: both orders updated");

  // ---- someone sells into what's left of the buy order (0.0035 SOL left; 100 tokens would need 0.006)
  ok(
    fails(
      [taker3, matcher],
      mkAta(taker3, maker2Stealth.publicKey),
      E.fillBuy({
        taker: taker3.publicKey,
        matcher: matcher.publicKey,
        feeWallet: fee.publicKey,
        maker: maker2.publicKey,
        mint,
        takerSrc: ata(taker3.publicKey),
        payoutDest: ata(maker2Stealth.publicKey),
        order: buyOrder,
        tokenProgram,
        amount: T(100),
        reveal: crossArgs.buy,
      }),
    ),
    "fill_buy larger than the escrowed SOL is refused",
  );
  const sellInto = T(50);
  const fbCost = E.costFloor(sellInto, buyPrice);
  const fbFee = E.feeOf(fbCost, FEE_BPS);
  const t3Before = bal(taker3.publicKey);
  sendOk(
    [taker3, matcher],
    mkAta(taker3, maker2Stealth.publicKey),
    E.fillBuy({
      taker: taker3.publicKey,
      matcher: matcher.publicKey,
      feeWallet: fee.publicKey,
      maker: maker2.publicKey,
      mint,
      takerSrc: ata(taker3.publicKey),
      payoutDest: ata(maker2Stealth.publicKey),
      order: buyOrder,
      tokenProgram,
      amount: sellInto,
      reveal: crossArgs.buy,
    }),
  );
  ok(tokens(ata(maker2Stealth.publicKey)) === T(350), "fill_buy: 50 more tokens to the buyer's stealth wallet");
  // taker3 pays the network fee for both signatures (taker + matcher): 2 × 5,000
  ok(bal(taker3.publicKey) - t3Before === fbCost - fbFee - 10_000n, "fill_buy: seller received the SOL (less 0.5% fee and network fee)");

  // ---- cancels hand everything back, and only to the owner
  ok(fails([stranger], E.cancelSell({ maker: stranger.publicKey, mint, makerAta: ata(stranger.publicKey), order: sellOrder, tokenProgram })), "a stranger cannot cancel someone else's order");
  const sellerTokens = tokens(ata(seller.publicKey));
  const sellerLamports = bal(seller.publicKey);
  sendOk([seller], E.cancelSell({ maker: seller.publicKey, mint, makerAta: ata(seller.publicKey), order: sellOrder, tokenProgram }));
  ok(tokens(ata(seller.publicKey)) === sellerTokens + T(300), "cancel_sell: the unsold 300 tokens came back");
  ok(!svm.getAccount(sellOrder)?.lamports && !svm.getAccount(E.vaultPda(sellOrder))?.lamports, "cancel_sell: order and vault closed");
  ok(bal(seller.publicKey) > sellerLamports, "cancel_sell: rent came back to the seller");

  // ---- pause: new business stops, cancel still works
  sendOk([admin], E.setConfig({ admin: admin.publicKey, newAdmin: admin.publicKey, matcher: matcher.publicKey, feeWallet: fee.publicKey, feeBps: FEE_BPS, paused: true }));
  ok(
    fails([seller], E.openSell({ maker: seller.publicKey, mint, makerAta: ata(seller.publicKey), tokenProgram, nonce: 99n, amount: T(1), commitment: E.commitment(1n, seller.publicKey, E.randomSalt()) })),
    "paused: open_sell is refused",
  );
  const leftInBuy = order(buyOrder)!.left;
  const m2Before = bal(maker2.publicKey);
  sendOk([maker2], E.cancelBuy({ maker: maker2.publicKey, order: buyOrder }));
  ok(bal(maker2.publicKey) - m2Before >= leftInBuy, "paused: cancel_buy still returns the escrowed SOL");
  sendOk([admin], E.setConfig({ admin: admin.publicKey, newAdmin: admin.publicKey, matcher: matcher.publicKey, feeWallet: fee.publicKey, feeBps: FEE_BPS, paused: false }));

  // ---- a full fill closes the order and refunds rent
  const smallNonce = 2n;
  const smallOrder = E.orderPda(seller.publicKey, smallNonce);
  const smallSalt = E.randomSalt();
  sendOk([seller], E.openSell({ maker: seller.publicKey, mint, makerAta: ata(seller.publicKey), tokenProgram, nonce: smallNonce, amount: T(50), commitment: E.commitment(sellPrice, sellerFresh.publicKey, smallSalt) }));
  const beforeClose = bal(seller.publicKey);
  sendOk([buyer, matcher], E.fillSell({ ...fillArgs, order: smallOrder, amount: T(50), reveal: { price: sellPrice, payout: sellerFresh.publicKey, salt: smallSalt } }));
  ok(!svm.getAccount(smallOrder)?.lamports, "full fill: order closed");
  ok(bal(seller.publicKey) > beforeClose, "full fill: rent went back to the seller, who didn't sign");
}

run(TOKEN_PROGRAM_ID, "SPL Token");
run(TOKEN_2022_PROGRAM_ID, "Token-2022 (pump.fun coins)");
console.log(`\nall ${passed} checks passed`);

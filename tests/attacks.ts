/**
 * Security probes for offchange_escrow: each one tries an attack against the
 * deployed build and reports whether it lands. LiteSVM, no network.
 *   npm run attacks
 */
import { readFileSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ExtensionType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import * as E from "../client/escrow";

const SO = "target/deploy/offchange_escrow.so";
const DEC = 6;
const T = (n: number) => BigInt(n) * 10n ** BigInt(DEC);

const results: { probe: string; landed: boolean; note: string }[] = [];
const report = (probe: string, landed: boolean, note: string) => {
  results.push({ probe, landed, note });
  console.log(`${landed ? "⚠ LANDS " : "✓ blocked"}  ${probe}\n           ${note}`);
};

function world(tokenProgram: PublicKey, transferFeeBps = 0) {
  const svm = new LiteSVM();
  svm.addProgram(E.PROGRAM_ID, readFileSync(SO));
  const [admin, matcher, fee, seller, sellerFresh, buyer, buyerStealth, stranger, mintKp] = Array.from({ length: 9 }, () => Keypair.generate());
  for (const k of [admin, matcher, fee, seller, buyer, stranger]) svm.airdrop(k.publicKey, 10n * BigInt(LAMPORTS_PER_SOL));
  const mint = mintKp.publicKey;

  const send = (signers: Keypair[], ...ixs: TransactionInstruction[]) => {
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    const res = svm.sendTransaction(tx);
    svm.expireBlockhash();
    return res instanceof FailedTransactionMetadata ? { ok: false, logs: res.meta().logs() } : { ok: true, logs: res.logs() };
  };
  const must = (signers: Keypair[], ...ixs: TransactionInstruction[]) => {
    const r = send(signers, ...ixs);
    if (!r.ok) throw new Error("setup failed:\n" + r.logs.join("\n"));
  };
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const tokens = (acct: PublicKey) => {
    const a = svm.getAccount(acct);
    return a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
  };
  const mkAta = (payer: Keypair, owner: PublicKey) =>
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(owner), owner, mint, tokenProgram);

  const exts = transferFeeBps ? [ExtensionType.TransferFeeConfig] : [];
  const space = exts.length ? getMintLen(exts) : MINT_SIZE;
  must(
    [admin, mintKp],
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: mint,
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(space))),
      space,
      programId: tokenProgram,
    }),
    ...(transferFeeBps ? [createInitializeTransferFeeConfigInstruction(mint, admin.publicKey, admin.publicKey, transferFeeBps, T(1_000_000), tokenProgram)] : []),
    createInitializeMint2Instruction(mint, DEC, admin.publicKey, null, tokenProgram),
    mkAta(admin, seller.publicKey),
    mkAta(admin, stranger.publicKey),
    createMintToInstruction(mint, ata(seller.publicKey), admin.publicKey, T(10_000), [], tokenProgram),
    createMintToInstruction(mint, ata(stranger.publicKey), admin.publicKey, T(10), [], tokenProgram),
  );
  must([admin], E.initConfig({ admin: admin.publicKey, matcher: matcher.publicKey, feeWallet: fee.publicKey, feeBps: 50 }));
  return { svm, send, must, ata, tokens, mkAta, admin, matcher, fee, seller, sellerFresh, buyer, buyerStealth, stranger, mint, tokenProgram };
}

function openSellOrder(w: ReturnType<typeof world>, amount: bigint, price = 50_000n, payout?: PublicKey) {
  const salt = E.randomSalt();
  const nonce = BigInt(Math.floor(Math.random() * 1e9));
  const order = E.orderPda(w.seller.publicKey, nonce);
  const pay = payout ?? w.sellerFresh.publicKey;
  w.must(
    [w.seller],
    E.openSell({ maker: w.seller.publicKey, mint: w.mint, makerAta: w.ata(w.seller.publicKey), tokenProgram: w.tokenProgram, nonce, amount, commitment: E.commitment(price, pay, salt) }),
  );
  const fill = (amt: bigint) =>
    E.fillSell({
      taker: w.buyer.publicKey,
      matcher: w.matcher.publicKey,
      feeWallet: w.fee.publicKey,
      maker: w.seller.publicKey,
      mint: w.mint,
      order,
      takerDest: w.ata(w.buyerStealth.publicKey),
      tokenProgram: w.tokenProgram,
      amount: amt,
      reveal: { price, payout: pay, salt },
    });
  const cancel = () => E.cancelSell({ maker: w.seller.publicKey, mint: w.mint, makerAta: w.ata(w.seller.publicKey), order, tokenProgram: w.tokenProgram });
  return { order, vault: E.vaultPda(order), fill, cancel };
}

/* 1. A stranger donates 1 base unit into an order's vault to block the final fill. */
for (const [tp, label] of [[TOKEN_PROGRAM_ID, "SPL"], [TOKEN_2022_PROGRAM_ID, "Token-2022"]] as const) {
  const w = world(tp);
  const o = openSellOrder(w, T(100));
  w.must([w.stranger], createTransferCheckedInstruction(w.ata(w.stranger.publicKey), w.mint, o.vault, w.stranger.publicKey, 1n, DEC, [], tp));
  const full = w.send([w.buyer, w.matcher], w.mkAta(w.buyer, w.buyerStealth.publicKey), o.fill(T(100)));
  const after = w.svm.getAccount(o.order);
  const left = after?.data.length ? E.decodeOrder(after.data).left : null;
  const before = w.tokens(w.ata(w.seller.publicKey));
  const sweep = w.send([w.seller], o.cancel());
  const swept = w.tokens(w.ata(w.seller.publicKey)) - before;
  report(
    `[${label}] grief: 1 donated unit blocks the final fill`,
    !full.ok,
    full.ok ? `final fill settles; order kept at left=${left}, cancel ${sweep.ok ? `sweeps the ${swept} donated unit to the maker` : "FAILS"}` : "final fill still fails",
  );
}

/* 2. A Token-2022 coin with a transfer fee tries to enter the pool. */
{
  const w = world(TOKEN_2022_PROGRAM_ID, 100); // 1% transfer fee
  const salt = E.randomSalt();
  const r = w.send(
    [w.seller],
    E.openSell({ maker: w.seller.publicKey, mint: w.mint, makerAta: w.ata(w.seller.publicKey), tokenProgram: w.tokenProgram, nonce: 7n, amount: T(100), commitment: E.commitment(1n, w.seller.publicKey, salt) }),
  );
  const bal = w.tokens(w.ata(w.seller.publicKey));
  report(
    "[Token-2022 transfer fee] coin enters escrow and gets stuck",
    r.ok,
    r.ok ? "order opened" : `open_sell refused (${r.logs.find((l) => l.includes("Error Message"))?.split("Error Message: ")[1] ?? "error"}); seller keeps all ${bal / 10n ** BigInt(DEC)} tokens`,
  );
}

/* 3. A fill whose proceeds are below rent into a brand-new payout wallet: still a chain rule, the server sizes around it. */
{
  const w = world(TOKEN_PROGRAM_ID);
  const fresh = Keypair.generate().publicKey;
  const o = openSellOrder(w, T(100), 1_000n, fresh);
  const small = w.send([w.buyer, w.matcher], w.mkAta(w.buyer, w.buyerStealth.publicKey), o.fill(T(10)));
  report("small fill into an empty payout wallet (chain rule)", false, small.ok ? "settles" : "the chain refuses it; the engine now skips such fills instead of failing a user's transaction");
}

/* 4. A stale order: time passes its expiry, then someone tries to fill it. */
{
  const w = world(TOKEN_PROGRAM_ID);
  const o = openSellOrder(w, T(100));
  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000) + E.ORDER_TTL_SECS + 60);
  w.svm.setClock(clock);
  const late = w.send([w.buyer, w.matcher], w.mkAta(w.buyer, w.buyerStealth.publicKey), o.fill(T(10)));
  const cancel = w.send([w.seller], o.cancel());
  report("stale order filled after its expiry", late.ok, late.ok ? "fill lands on a stale price" : `fill refused after expiry; cancel ${cancel.ok ? "still returns the coins" : "FAILS"}`);
}

/* 5. Opening an order that is already expired. */
{
  const w = world(TOKEN_PROGRAM_ID);
  const clock = w.svm.getClock();
  clock.unixTimestamp = 2_000_000_000n;
  w.svm.setClock(clock);
  const r = w.send(
    [w.seller],
    E.openSell({ maker: w.seller.publicKey, mint: w.mint, makerAta: w.ata(w.seller.publicKey), tokenProgram: w.tokenProgram, nonce: 8n, amount: T(1), commitment: E.commitment(1n, w.seller.publicKey, E.randomSalt()), expiresAt: 1_999_999_999n }),
  );
  report("open an order that is already expired", r.ok, r.ok ? "accepted" : "refused");
}

/* 6. On-chain visibility of a resting order (by design; the docs now say so). */
{
  const w = world(TOKEN_PROGRAM_ID);
  const o = openSellOrder(w, T(1_234));
  const acct = E.decodeOrder(w.svm.getAccount(o.order)!.data);
  report("resting order size is readable on chain (documented)", false, `left=${acct.left} is public; price and payout stay hidden behind the commitment`);
}

/* 7. Admin raises the fee above the 1% ceiling. */
{
  const w = world(TOKEN_PROGRAM_ID);
  const raise = w.send(
    [w.admin],
    E.setConfig({ admin: w.admin.publicKey, newAdmin: w.admin.publicKey, matcher: w.matcher.publicKey, feeWallet: w.fee.publicKey, feeBps: 101, paused: false }),
  );
  report("admin raises the fee above 1%", raise.ok, raise.ok ? "fee above cap accepted" : "refused by the program's 1% ceiling");
}

const landed = results.filter((r) => r.landed).length;
console.log(`\n${results.length} probes, ${landed} landed`);
if (landed) process.exit(1);

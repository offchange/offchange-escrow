/**
 * Client for the offchange_escrow program: PDAs, the price commitment,
 * instruction builders and account decoders. Shared by the app, the server and
 * the tests. Account order in every builder mirrors the program's Accounts
 * structs exactly.
 */
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha2";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("HNNL8jdJwqfoBsjYmh86kKB61Lm3jJzxwEgzdzEK4ifz");
/** prices are lamports per PRICE_SCALE base units of the coin */
export const PRICE_SCALE = 1_000_000n;
export const SIDE_SELL = 0;
export const SIDE_BUY = 1;
/** Order account size on chain, used to filter getProgramAccounts. */
export const ORDER_SIZE = 147;
/** How long an order rests before fills stop, unless the maker picks otherwise. */
export const ORDER_TTL_SECS = 7 * 24 * 3600;
export const defaultExpiry = () => BigInt(Math.floor(Date.now() / 1000) + ORDER_TTL_SECS);

const enc = new TextEncoder();
const disc = (name: string) => sha256(enc.encode(`global:${name}`)).slice(0, 8);
const accDisc = (name: string) => sha256(enc.encode(`account:${name}`)).slice(0, 8);
const ORDER_DISC = accDisc("Order");
const CONFIG_DISC = accDisc("Config");

/* ------------------------------------------------------------------ bytes */

const u64 = (v: bigint | number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};
const i64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
};
const u16 = (v: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const bytes32 = (v: Uint8Array) => {
  if (v.length !== 32) throw new Error("expected 32 bytes");
  return v;
};

/* ------------------------------------------------------------------ pdas */

export const configPda = () => PublicKey.findProgramAddressSync([enc.encode("config")], PROGRAM_ID)[0];

export const orderPda = (maker: PublicKey, nonce: bigint) =>
  PublicKey.findProgramAddressSync([enc.encode("order"), maker.toBuffer(), u64(nonce)], PROGRAM_ID)[0];

export const vaultPda = (order: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("vault"), order.toBuffer()], PROGRAM_ID)[0];

/* ------------------------------------------------------------------ pricing */

/** sha256(price_le || payout || salt), exactly as the program computes it */
export const commitment = (price: bigint, payout: PublicKey, salt: Uint8Array) =>
  sha256(concat(u64(price), payout.toBytes(), bytes32(salt)));

export const randomSalt = () => crypto.getRandomValues(new Uint8Array(32));

/** lamports for `amount` base units at `price`, rounded the way the program does */
export const costFloor = (amount: bigint, price: bigint) => (amount * price) / PRICE_SCALE;
export const costCeil = (amount: bigint, price: bigint) => (amount * price + PRICE_SCALE - 1n) / PRICE_SCALE;
export const feeOf = (cost: bigint, bps: number) => (cost * BigInt(bps)) / 10_000n;

/* ------------------------------------------------------------------ instructions */

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const ix = (keys: AccountMeta[], data: Uint8Array) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.from(data) });

export function initConfig(a: { admin: PublicKey; matcher: PublicKey; feeWallet: PublicKey; feeBps: number }) {
  return ix(
    [w(a.admin, true), w(configPda()), r(SystemProgram.programId)],
    concat(disc("init_config"), a.matcher.toBytes(), a.feeWallet.toBytes(), u16(a.feeBps)),
  );
}

export function setConfig(a: {
  admin: PublicKey;
  newAdmin: PublicKey;
  matcher: PublicKey;
  feeWallet: PublicKey;
  feeBps: number;
  paused: boolean;
}) {
  return ix(
    [r(a.admin, true), w(configPda())],
    concat(
      disc("set_config"),
      a.newAdmin.toBytes(),
      a.matcher.toBytes(),
      a.feeWallet.toBytes(),
      u16(a.feeBps),
      new Uint8Array([a.paused ? 1 : 0]),
    ),
  );
}

export function openSell(a: {
  maker: PublicKey;
  mint: PublicKey;
  makerAta: PublicKey;
  tokenProgram: PublicKey;
  nonce: bigint;
  amount: bigint;
  commitment: Uint8Array;
  expiresAt?: bigint;
}) {
  const order = orderPda(a.maker, a.nonce);
  return ix(
    [
      w(a.maker, true),
      r(configPda()),
      r(a.mint),
      w(a.makerAta),
      w(order),
      w(vaultPda(order)),
      r(a.tokenProgram),
      r(SystemProgram.programId),
    ],
    concat(disc("open_sell"), u64(a.nonce), u64(a.amount), bytes32(a.commitment), i64(a.expiresAt ?? defaultExpiry())),
  );
}

export function openBuy(a: { maker: PublicKey; mint: PublicKey; nonce: bigint; lamports: bigint; commitment: Uint8Array; expiresAt?: bigint }) {
  return ix(
    [w(a.maker, true), r(configPda()), r(a.mint), w(orderPda(a.maker, a.nonce)), r(SystemProgram.programId)],
    concat(disc("open_buy"), u64(a.nonce), u64(a.lamports), bytes32(a.commitment), i64(a.expiresAt ?? defaultExpiry())),
  );
}

export function cancelSell(a: { maker: PublicKey; mint: PublicKey; makerAta: PublicKey; order: PublicKey; tokenProgram: PublicKey }) {
  return ix(
    [w(a.maker, true), r(a.mint), w(a.makerAta), w(a.order), w(vaultPda(a.order)), r(a.tokenProgram)],
    disc("cancel_sell"),
  );
}

export function cancelBuy(a: { maker: PublicKey; order: PublicKey }) {
  return ix([w(a.maker, true), w(a.order)], disc("cancel_buy"));
}

type Reveal = { price: bigint; payout: PublicKey; salt: Uint8Array };

export function fillSell(a: {
  taker: PublicKey;
  matcher: PublicKey;
  feeWallet: PublicKey;
  maker: PublicKey;
  mint: PublicKey;
  order: PublicKey;
  takerDest: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
  reveal: Reveal;
}) {
  return ix(
    [
      w(a.taker, true),
      r(a.matcher, true),
      r(configPda()),
      w(a.feeWallet),
      w(a.maker),
      w(a.reveal.payout),
      r(a.mint),
      w(a.order),
      w(vaultPda(a.order)),
      w(a.takerDest),
      r(a.tokenProgram),
      r(SystemProgram.programId),
    ],
    concat(disc("fill_sell"), u64(a.amount), u64(a.reveal.price), a.reveal.payout.toBytes(), bytes32(a.reveal.salt)),
  );
}

export function fillBuy(a: {
  taker: PublicKey;
  matcher: PublicKey;
  feeWallet: PublicKey;
  maker: PublicKey;
  mint: PublicKey;
  takerSrc: PublicKey;
  payoutDest: PublicKey;
  order: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
  reveal: Reveal;
}) {
  return ix(
    [
      w(a.taker, true),
      r(a.matcher, true),
      r(configPda()),
      w(a.feeWallet),
      w(a.maker),
      r(a.reveal.payout),
      r(a.mint),
      w(a.takerSrc),
      w(a.payoutDest),
      w(a.order),
      r(a.tokenProgram),
      r(SystemProgram.programId),
    ],
    concat(disc("fill_buy"), u64(a.amount), u64(a.reveal.price), a.reveal.payout.toBytes(), bytes32(a.reveal.salt)),
  );
}

export function cross(a: {
  matcher: PublicKey;
  feeWallet: PublicKey;
  mint: PublicKey;
  sellOrder: PublicKey;
  sellMaker: PublicKey;
  buyOrder: PublicKey;
  buyMaker: PublicKey;
  buyPayoutDest: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
  sell: Reveal;
  buy: Reveal;
}) {
  return ix(
    [
      r(a.matcher, true),
      r(configPda()),
      w(a.feeWallet),
      r(a.mint),
      w(a.sellOrder),
      w(vaultPda(a.sellOrder)),
      w(a.sellMaker),
      w(a.sell.payout),
      w(a.buyOrder),
      w(a.buyMaker),
      r(a.buy.payout),
      w(a.buyPayoutDest),
      r(a.tokenProgram),
    ],
    concat(
      disc("cross"),
      u64(a.amount),
      u64(a.sell.price),
      a.sell.payout.toBytes(),
      bytes32(a.sell.salt),
      u64(a.buy.price),
      a.buy.payout.toBytes(),
      bytes32(a.buy.salt),
    ),
  );
}

/* ------------------------------------------------------------------ accounts */

export type OrderAccount = {
  maker: PublicKey;
  mint: PublicKey;
  side: number;
  nonce: bigint;
  total: bigint;
  left: bigint;
  commitment: Uint8Array;
  createdAt: bigint;
  expiresAt: bigint;
};

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function decodeOrder(data: Uint8Array): OrderAccount {
  if (!same(data.slice(0, 8), ORDER_DISC)) throw new Error("not an Order account");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    maker: new PublicKey(data.slice(8, 40)),
    mint: new PublicKey(data.slice(40, 72)),
    side: data[72],
    nonce: v.getBigUint64(73, true),
    total: v.getBigUint64(81, true),
    left: v.getBigUint64(89, true),
    commitment: data.slice(97, 129),
    createdAt: v.getBigInt64(129, true),
    expiresAt: v.getBigInt64(139, true),
  };
}

export type ConfigAccount = { admin: PublicKey; matcher: PublicKey; feeWallet: PublicKey; feeBps: number; paused: boolean };

export function decodeConfig(data: Uint8Array): ConfigAccount {
  if (!same(data.slice(0, 8), CONFIG_DISC)) throw new Error("not a Config account");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    admin: new PublicKey(data.slice(8, 40)),
    matcher: new PublicKey(data.slice(40, 72)),
    feeWallet: new PublicKey(data.slice(72, 104)),
    feeBps: v.getUint16(104, true),
    paused: data[106] === 1,
  };
}

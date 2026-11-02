# Offchange escrow

The on-chain program behind [Offchange](https://offchange.trade), a dark pool for memecoins on
Solana. Orders rest in escrow with their price and payout wallet sealed behind a hash. A fill has
to reveal both, and the program checks the reveal before anything moves.

| | |
|---|---|
| Program | [`HNNL8jdJwqfoBsjYmh86kKB61Lm3jJzxwEgzdzEK4ifz`](https://solscan.io/account/HNNL8jdJwqfoBsjYmh86kKB61Lm3jJzxwEgzdzEK4ifz) |
| Config | [`ASZwj24RR4amJU2ZEWjugTSfFgFe1tp5QnFPNZE2gFcc`](https://solscan.io/account/ASZwj24RR4amJU2ZEWjugTSfFgFe1tp5QnFPNZE2gFcc) |
| Network | Solana mainnet |
| Framework | Anchor 1.2 |
| Fee | 0.5%, hard-capped at 1% in code |
| Upgrades | Upgradeable for now; the authority will be frozen once the pool has settled in |
| Audit | Not audited by a third party yet |

## How an order works

1. **Open.** A seller escrows coins (`open_sell`), or a buyer escrows SOL (`open_buy`). The order
   stores `sha256(price ‖ payout ‖ salt)`, never the price or the payout wallet themselves, plus an
   expiry.
2. **Fill.** A taker fills against a resting order (`fill_sell`, `fill_buy`). The transaction must
   carry the price, payout and salt that hash to the stored commitment, and it must be co-signed
   by the matcher named in the config.
3. **Cross.** Two resting orders meet (`cross`) when the buy price is at or above the sell price.
   They settle at the midpoint of the two committed prices.
4. **Cancel.** The maker takes back everything that is left (`cancel_sell`, `cancel_buy`), at any
   time, including after expiry and while the pool is paused.

Prices are lamports per 1,000,000 base units of the coin.

## What the program guarantees

- **Price and payout are enforced on chain.** A reveal that doesn't match the commitment is
  refused, so nobody, the matcher included, can fill an order at another price or pay another
  wallet.
- **The exit never depends on the operator.** Only the maker's signature is needed to cancel,
  and cancel works while paused and after expiry.
- **The matcher only decides who meets.** Its signature keeps the book dark, but it can't move
  funds outside a commitment the owner signed.
- **Orders go stale on purpose.** Fills and crosses stop at the order's expiry, so an old price
  can't be taken after the market has moved.
- **The fee can't exceed 1%.** `set_config` refuses anything above `MAX_FEE_BPS = 100`.
- **Risky coins stay out.** Plain SPL coins are accepted. Token-2022 coins are accepted only with
  metadata, group, close-authority, interest-bearing or scaled-amount extensions. Transfer fees,
  transfer hooks, permanent delegates, default-frozen accounts and the rest are refused, because
  they can take or block coins sitting in escrow.

## What stays public

The escrow is an ordinary account on chain. Anyone reading the program's accounts can see that a
wallet has an order, in which coin, and how big it is. The price and the payout wallet stay
hidden until a fill reveals them. Order accounts are 147 bytes; the layout is in
[`client/escrow.ts`](client/escrow.ts) (`decodeOrder`).

## Instructions

| Instruction | Signers | Does |
|---|---|---|
| `init_config` | admin | Sets matcher, fee wallet and fee, once |
| `set_config` | admin | Changes them, or pauses new orders and fills |
| `open_sell` | maker | Escrows coins behind a commitment |
| `open_buy` | maker | Escrows SOL behind a commitment |
| `cancel_sell` | maker | Returns coins and rent |
| `cancel_buy` | maker | Returns SOL and rent |
| `fill_sell` | taker, matcher | Taker buys coins from a resting sell order |
| `fill_buy` | taker, matcher | Taker sells coins into a resting buy order |
| `cross` | matcher | Settles a resting buy against a resting sell |

Accounts are PDAs: `["config"]`, `["order", maker, nonce_le]` and `["vault", order]`.

## Build and test

Requires Rust with the Solana platform tools (`cargo build-sbf`) and Node 22 or newer.

```sh
npm install
npm run build     # target/deploy/offchange_escrow.so
npm test          # 58 checks on SPL Token and Token-2022, in LiteSVM
npm run attacks   # the attack suite: every probe must be blocked
```

The tests run in-process with [LiteSVM](https://github.com/LiteSVM/litesvm): no validator, no
network, no SOL.

## Security

The program has not been audited by a third party. `tests/attacks.ts` covers the attacks found
in our own review: fake reveals, fake matchers, over-fills, griefing donations into a vault,
transfer-fee coins, stale orders and fee changes past the cap.

If you find a vulnerability, please report it privately through this repository's
**Security → Report a vulnerability** tab rather than in a public issue.

## License

[Apache-2.0](LICENSE)

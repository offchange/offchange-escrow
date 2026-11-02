//! Offchange escrow: a dark pool for memecoins.
//!
//! Orders sit in escrow with their price and payout wallet hidden behind a
//! sha256 commitment. A fill reveals them, and the program checks the reveal
//! against the commitment before anything moves, so the matcher (our server)
//! can decide *which* orders meet but can never move funds at a price the
//! owner didn't commit to. Owners can cancel at any time, even while paused.
//!
//! Prices are lamports per PRICE_SCALE base units of the coin.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_lang::system_program;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
};

declare_id!("HNNL8jdJwqfoBsjYmh86kKB61Lm3jJzxwEgzdzEK4ifz");

pub const PRICE_SCALE: u128 = 1_000_000;
pub const MAX_FEE_BPS: u16 = 100; // 1%
pub const SIDE_SELL: u8 = 0;
pub const SIDE_BUY: u8 = 1;

#[program]
pub mod offchange_escrow {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, matcher: Pubkey, fee_wallet: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, OffError::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.matcher = matcher;
        c.fee_wallet = fee_wallet;
        c.fee_bps = fee_bps;
        c.paused = false;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_config(
        ctx: Context<SetConfig>,
        admin: Pubkey,
        matcher: Pubkey,
        fee_wallet: Pubkey,
        fee_bps: u16,
        paused: bool,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, OffError::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.admin = admin;
        c.matcher = matcher;
        c.fee_wallet = fee_wallet;
        c.fee_bps = fee_bps;
        c.paused = paused;
        Ok(())
    }

    /// Escrow `amount` of the coin for sale.
    pub fn open_sell(ctx: Context<OpenSell>, nonce: u64, amount: u64, commitment: [u8; 32], expires_at: i64) -> Result<()> {
        require!(!ctx.accounts.config.paused, OffError::Paused);
        require!(amount > 0, OffError::ZeroAmount);
        check_mint(&ctx.accounts.mint.to_account_info())?;
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, OffError::Expired);

        let order = &mut ctx.accounts.order;
        order.maker = ctx.accounts.maker.key();
        order.mint = ctx.accounts.mint.key();
        order.side = SIDE_SELL;
        order.nonce = nonce;
        order.total = amount;
        order.left = amount;
        order.commitment = commitment;
        order.created_at = now;
        order.expires_at = expires_at;
        order.bump = ctx.bumps.order;
        order.vault_bump = ctx.bumps.vault;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.maker_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// Escrow `lamports` of SOL to buy the coin.
    pub fn open_buy(ctx: Context<OpenBuy>, nonce: u64, lamports: u64, commitment: [u8; 32], expires_at: i64) -> Result<()> {
        require!(!ctx.accounts.config.paused, OffError::Paused);
        require!(lamports > 0, OffError::ZeroAmount);
        check_mint(&ctx.accounts.mint.to_account_info())?;
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, OffError::Expired);

        let order = &mut ctx.accounts.order;
        order.maker = ctx.accounts.maker.key();
        order.mint = ctx.accounts.mint.key();
        order.side = SIDE_BUY;
        order.nonce = nonce;
        order.total = lamports;
        order.left = lamports;
        order.commitment = commitment;
        order.created_at = now;
        order.expires_at = expires_at;
        order.bump = ctx.bumps.order;
        order.vault_bump = 0;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.maker.to_account_info(),
                    to: ctx.accounts.order.to_account_info(),
                },
            ),
            lamports,
        )
    }

    /// Return the unsold coin and every lamport of rent to the maker. Works while paused.
    pub fn cancel_sell(ctx: Context<CancelSell>) -> Result<()> {
        let order = &ctx.accounts.order;
        let seeds: &[&[u8]] = &[b"order", order.maker.as_ref(), &order.nonce.to_le_bytes(), &[order.bump]];
        let left = ctx.accounts.vault.amount;
        if left > 0 {
            vault_transfer(
                &ctx.accounts.token_program,
                &ctx.accounts.vault,
                &ctx.accounts.mint,
                &ctx.accounts.maker_ata.to_account_info(),
                &order.to_account_info(),
                seeds,
                left,
            )?;
        }
        close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.maker.to_account_info(),
            &order.to_account_info(),
            seeds,
        )
        // the order account itself closes to the maker via `close = maker`
    }

    /// Return the escrowed SOL and rent to the maker. Works while paused.
    pub fn cancel_buy(_ctx: Context<CancelBuy>) -> Result<()> {
        Ok(()) // `close = maker` hands back every lamport
    }

    /// A taker buys `amount` of the coin from a resting sell order at its committed price.
    pub fn fill_sell(ctx: Context<FillSell>, amount: u64, price: u64, payout: Pubkey, salt: [u8; 32]) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OffError::Paused);
        require!(amount > 0, OffError::ZeroAmount);
        let order = &ctx.accounts.order;
        check_live(order)?;
        check_commitment(order, price, &payout, &salt)?;
        require_keys_eq!(ctx.accounts.payout.key(), payout, OffError::BadPayout);
        require!(amount <= order.left, OffError::TooMuch);

        let cost = cost_ceil(amount, price)?;
        let fee = fee_of(cost, config.fee_bps)?;
        require!(cost > fee, OffError::DustFill);

        // SOL: taker → seller's payout (and the fee)
        sol_from_signer(&ctx.accounts.system_program, &ctx.accounts.taker, &ctx.accounts.payout.to_account_info(), cost - fee)?;
        if fee > 0 {
            sol_from_signer(&ctx.accounts.system_program, &ctx.accounts.taker, &ctx.accounts.fee_wallet.to_account_info(), fee)?;
        }

        // coin: vault → taker
        let (maker_key, nonce_le, bump) = (order.maker, order.nonce.to_le_bytes(), [order.bump]);
        let left = order.left - amount;
        let seeds: &[&[u8]] = &[b"order", maker_key.as_ref(), &nonce_le, &bump];
        vault_transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.taker_dest.to_account_info(),
            &ctx.accounts.order.to_account_info(),
            seeds,
            amount,
        )?;

        ctx.accounts.order.left = left;
        if left == 0 {
            // coins anyone sent into the vault keep it open; the maker sweeps them with cancel
            ctx.accounts.vault.reload()?;
            if ctx.accounts.vault.amount == 0 {
                let order_info = ctx.accounts.order.to_account_info();
                close_vault(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.maker.to_account_info(), &order_info, seeds)?;
                ctx.accounts.order.close(ctx.accounts.maker.to_account_info())?;
            }
        }
        emit!(Filled { order: ctx.accounts.order.key(), mint: ctx.accounts.mint.key(), side: SIDE_SELL, amount, price, cost, fee });
        Ok(())
    }

    /// A taker sells `amount` of the coin into a resting buy order at its committed price.
    pub fn fill_buy(ctx: Context<FillBuy>, amount: u64, price: u64, payout: Pubkey, salt: [u8; 32]) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OffError::Paused);
        require!(amount > 0, OffError::ZeroAmount);
        let order = &ctx.accounts.order;
        check_live(order)?;
        check_commitment(order, price, &payout, &salt)?;
        require_keys_eq!(ctx.accounts.payout.key(), payout, OffError::BadPayout);

        let cost = cost_floor(amount, price)?;
        let fee = fee_of(cost, config.fee_bps)?;
        require!(cost > fee, OffError::DustFill);
        require!(cost <= order.left, OffError::TooMuch);

        // coin: taker → buyer's payout
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.taker_src.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.payout_dest.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        // SOL: escrow → taker (and the fee)
        let order_info = ctx.accounts.order.to_account_info();
        move_lamports(&order_info, &ctx.accounts.taker.to_account_info(), cost - fee)?;
        if fee > 0 {
            move_lamports(&order_info, &ctx.accounts.fee_wallet.to_account_info(), fee)?;
        }

        let left = ctx.accounts.order.left - cost;
        ctx.accounts.order.left = left;
        if left == 0 {
            ctx.accounts.order.close(ctx.accounts.maker.to_account_info())?;
        }
        emit!(Filled { order: ctx.accounts.order.key(), mint: ctx.accounts.mint.key(), side: SIDE_BUY, amount, price, cost, fee });
        Ok(())
    }

    /// Two resting orders meet. Settles at the midpoint of the two committed prices.
    #[allow(clippy::too_many_arguments)]
    pub fn cross(
        ctx: Context<Cross>,
        amount: u64,
        sell_price: u64,
        sell_payout: Pubkey,
        sell_salt: [u8; 32],
        buy_price: u64,
        buy_payout: Pubkey,
        buy_salt: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OffError::Paused);
        require!(amount > 0, OffError::ZeroAmount);
        check_live(&ctx.accounts.sell_order)?;
        check_live(&ctx.accounts.buy_order)?;
        check_commitment(&ctx.accounts.sell_order, sell_price, &sell_payout, &sell_salt)?;
        check_commitment(&ctx.accounts.buy_order, buy_price, &buy_payout, &buy_salt)?;
        require_keys_eq!(ctx.accounts.sell_payout.key(), sell_payout, OffError::BadPayout);
        require_keys_eq!(ctx.accounts.buy_payout.key(), buy_payout, OffError::BadPayout);
        require!(buy_price >= sell_price, OffError::NoCross);
        require!(amount <= ctx.accounts.sell_order.left, OffError::TooMuch);

        let price = ((sell_price as u128 + buy_price as u128) / 2) as u64;
        let cost = cost_floor(amount, price)?;
        let fee = fee_of(cost, config.fee_bps)?;
        require!(cost > fee, OffError::DustFill);
        require!(cost <= ctx.accounts.buy_order.left, OffError::TooMuch);

        // coin: sell vault → buyer's payout
        let sell = &ctx.accounts.sell_order;
        let (sell_maker_key, sell_nonce_le, sell_bump) = (sell.maker, sell.nonce.to_le_bytes(), [sell.bump]);
        let sell_seeds: &[&[u8]] = &[b"order", sell_maker_key.as_ref(), &sell_nonce_le, &sell_bump];
        vault_transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.sell_vault,
            &ctx.accounts.mint,
            &ctx.accounts.buy_payout_dest.to_account_info(),
            &ctx.accounts.sell_order.to_account_info(),
            sell_seeds,
            amount,
        )?;

        // SOL: buy escrow → seller's payout (and the fee)
        let buy_info = ctx.accounts.buy_order.to_account_info();
        move_lamports(&buy_info, &ctx.accounts.sell_payout.to_account_info(), cost - fee)?;
        if fee > 0 {
            move_lamports(&buy_info, &ctx.accounts.fee_wallet.to_account_info(), fee)?;
        }

        let sell_left = ctx.accounts.sell_order.left - amount;
        ctx.accounts.sell_order.left = sell_left;
        let buy_left = ctx.accounts.buy_order.left - cost;
        ctx.accounts.buy_order.left = buy_left;

        if sell_left == 0 {
            ctx.accounts.sell_vault.reload()?;
            if ctx.accounts.sell_vault.amount == 0 {
                let info = ctx.accounts.sell_order.to_account_info();
                close_vault(&ctx.accounts.token_program, &ctx.accounts.sell_vault, &ctx.accounts.sell_maker.to_account_info(), &info, sell_seeds)?;
                ctx.accounts.sell_order.close(ctx.accounts.sell_maker.to_account_info())?;
            }
        }
        if buy_left == 0 {
            ctx.accounts.buy_order.close(ctx.accounts.buy_maker.to_account_info())?;
        }
        emit!(Crossed {
            sell_order: ctx.accounts.sell_order.key(),
            buy_order: ctx.accounts.buy_order.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            price,
            cost,
            fee,
        });
        Ok(())
    }
}

/* ------------------------------------------------------------------ helpers */

pub fn commitment_of(price: u64, payout: &Pubkey, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[&price.to_le_bytes(), payout.as_ref(), salt]).to_bytes()
}

fn check_live(order: &Order) -> Result<()> {
    require!(Clock::get()?.unix_timestamp < order.expires_at, OffError::Expired);
    Ok(())
}

/// Plain SPL coins pass. Token-2022 coins pass only with extensions that can't
/// take a cut of a transfer, block one, or move coins out of the vault.
fn check_mint(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    for ext in state.get_extension_types()? {
        require!(
            matches!(
                ext,
                ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
                    | ExtensionType::GroupPointer
                    | ExtensionType::TokenGroup
                    | ExtensionType::GroupMemberPointer
                    | ExtensionType::TokenGroupMember
                    | ExtensionType::MintCloseAuthority
                    | ExtensionType::InterestBearingConfig
                    | ExtensionType::ScaledUiAmount
            ),
            OffError::UnsupportedMint
        );
    }
    Ok(())
}

fn check_commitment(order: &Order, price: u64, payout: &Pubkey, salt: &[u8; 32]) -> Result<()> {
    require!(price > 0, OffError::ZeroAmount);
    require!(commitment_of(price, payout, salt) == order.commitment, OffError::BadCommitment);
    Ok(())
}

fn cost_floor(amount: u64, price: u64) -> Result<u64> {
    let v = (amount as u128).checked_mul(price as u128).ok_or(OffError::Math)? / PRICE_SCALE;
    u64::try_from(v).map_err(|_| error!(OffError::Math))
}

fn cost_ceil(amount: u64, price: u64) -> Result<u64> {
    let v = (amount as u128).checked_mul(price as u128).ok_or(OffError::Math)?;
    u64::try_from(v.div_ceil(PRICE_SCALE)).map_err(|_| error!(OffError::Math))
}

fn fee_of(cost: u64, bps: u16) -> Result<u64> {
    let v = (cost as u128).checked_mul(bps as u128).ok_or(OffError::Math)? / 10_000;
    Ok(v as u64)
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let from_now = from.lamports().checked_sub(amount).ok_or(OffError::Math)?;
    let to_now = to.lamports().checked_add(amount).ok_or(OffError::Math)?;
    **from.try_borrow_mut_lamports()? = from_now;
    **to.try_borrow_mut_lamports()? = to_now;
    Ok(())
}

fn sol_from_signer<'info>(sys: &Program<'info, System>, from: &Signer<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    system_program::transfer(
        CpiContext::new(sys.key(), system_program::Transfer { from: from.to_account_info(), to: to.clone() }),
        amount,
    )
}

fn vault_transfer<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.clone(),
                authority: authority.clone(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

fn close_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    dest: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount { account: vault.to_account_info(), destination: dest.clone(), authority: authority.clone() },
        &[seeds],
    ))
}

/* ------------------------------------------------------------------ state */

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub matcher: Pubkey,
    pub fee_wallet: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub maker: Pubkey,
    pub mint: Pubkey,
    pub side: u8,
    pub nonce: u64,
    /// sell: coin base units; buy: lamports
    pub total: u64,
    pub left: u64,
    pub commitment: [u8; 32],
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    /// fills and crosses stop at this unix time; cancel never does
    pub expires_at: i64,
}

#[event]
pub struct Filled {
    pub order: Pubkey,
    pub mint: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub price: u64,
    pub cost: u64,
    pub fee: u64,
}

#[event]
pub struct Crossed {
    pub sell_order: Pubkey,
    pub buy_order: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub price: u64,
    pub cost: u64,
    pub fee: u64,
}

#[error_code]
pub enum OffError {
    #[msg("The pool is paused")]
    Paused,
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("Fee above the 1% ceiling")]
    FeeTooHigh,
    #[msg("Price or payout does not match the order's commitment")]
    BadCommitment,
    #[msg("Payout account does not match")]
    BadPayout,
    #[msg("More than the order has left")]
    TooMuch,
    #[msg("Buy price is below sell price")]
    NoCross,
    #[msg("Fill too small to carry its fee")]
    DustFill,
    #[msg("Arithmetic overflow")]
    Math,
    #[msg("The order has expired")]
    Expired,
    #[msg("This coin's token extensions can take or block transfers")]
    UnsupportedMint,
}

/* ------------------------------------------------------------------ accounts */

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenSell<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = maker, token::token_program = token_program)]
    pub maker_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init, payer = maker, space = 8 + Order::INIT_SPACE,
        seeds = [b"order", maker.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(
        init, payer = maker, seeds = [b"vault", order.key().as_ref()], bump,
        token::mint = mint, token::authority = order, token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenBuy<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init, payer = maker, space = 8 + Order::INIT_SPACE,
        seeds = [b"order", maker.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub order: Box<Account<'info, Order>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelSell<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = maker, token::token_program = token_program)]
    pub maker_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut, close = maker, has_one = maker, has_one = mint,
        constraint = order.side == SIDE_SELL @ OffError::BadCommitment,
        seeds = [b"order", maker.key().as_ref(), &order.nonce.to_le_bytes()], bump = order.bump
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(mut, seeds = [b"vault", order.key().as_ref()], bump = order.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelBuy<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        mut, close = maker, has_one = maker,
        constraint = order.side == SIDE_BUY @ OffError::BadCommitment,
        seeds = [b"order", maker.key().as_ref(), &order.nonce.to_le_bytes()], bump = order.bump
    )]
    pub order: Box<Account<'info, Order>>,
}

#[derive(Accounts)]
pub struct FillSell<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    pub matcher: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = matcher, has_one = fee_wallet)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: matched against config.fee_wallet
    #[account(mut)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// CHECK: the order's maker, gets rent back when the order closes
    #[account(mut, address = order.maker)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: the seller's payout wallet, matched against the revealed commitment
    #[account(mut)]
    pub payout: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut, has_one = mint,
        constraint = order.side == SIDE_SELL @ OffError::BadCommitment,
        seeds = [b"order", order.maker.as_ref(), &order.nonce.to_le_bytes()], bump = order.bump
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(mut, seeds = [b"vault", order.key().as_ref()], bump = order.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub taker_dest: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FillBuy<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    pub matcher: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = matcher, has_one = fee_wallet)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: matched against config.fee_wallet
    #[account(mut)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// CHECK: the order's maker, gets rent back when the order closes
    #[account(mut, address = order.maker)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: the buyer's payout wallet, matched against the revealed commitment
    pub payout: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = taker, token::token_program = token_program)]
    pub taker_src: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = payout, token::token_program = token_program)]
    pub payout_dest: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut, has_one = mint,
        constraint = order.side == SIDE_BUY @ OffError::BadCommitment,
        seeds = [b"order", order.maker.as_ref(), &order.nonce.to_le_bytes()], bump = order.bump
    )]
    pub order: Box<Account<'info, Order>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Cross<'info> {
    pub matcher: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = matcher, has_one = fee_wallet)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: matched against config.fee_wallet
    #[account(mut)]
    pub fee_wallet: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut, has_one = mint,
        constraint = sell_order.side == SIDE_SELL @ OffError::BadCommitment,
        seeds = [b"order", sell_order.maker.as_ref(), &sell_order.nonce.to_le_bytes()], bump = sell_order.bump
    )]
    pub sell_order: Box<Account<'info, Order>>,
    #[account(mut, seeds = [b"vault", sell_order.key().as_ref()], bump = sell_order.vault_bump)]
    pub sell_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the sell order's maker, gets rent back when it closes
    #[account(mut, address = sell_order.maker)]
    pub sell_maker: UncheckedAccount<'info>,
    /// CHECK: matched against the sell order's revealed commitment
    #[account(mut)]
    pub sell_payout: UncheckedAccount<'info>,
    #[account(
        mut, has_one = mint,
        constraint = buy_order.side == SIDE_BUY @ OffError::BadCommitment,
        seeds = [b"order", buy_order.maker.as_ref(), &buy_order.nonce.to_le_bytes()], bump = buy_order.bump
    )]
    pub buy_order: Box<Account<'info, Order>>,
    /// CHECK: the buy order's maker, gets rent back when it closes
    #[account(mut, address = buy_order.maker)]
    pub buy_maker: UncheckedAccount<'info>,
    /// CHECK: matched against the buy order's revealed commitment
    pub buy_payout: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = buy_payout, token::token_program = token_program)]
    pub buy_payout_dest: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

//! `initialize_config` — create the singleton configuration registry.
//!
//! The initial administrator signs and pays the rent. All three authorities
//! must be explicit, non-default and distinct, so a single key cannot quietly
//! hold every power.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        CONFIG_ACCOUNT_SPACE, CONFIG_RESERVED_BYTES, CONFIG_SEED, CONFIG_VERSION,
    },
    error::FlashboltError,
    state::{Config, ConfigInitialized},
};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = CONFIG_ACCOUNT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    /// The initial administrator. Must sign; funds the config account.
    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle(
    ctx: Context<InitializeConfig>,
    executor: Pubkey,
    pause_authority: Pubkey,
) -> Result<()> {
    let admin = ctx.accounts.admin.key();

    require!(
        executor != Pubkey::default(),
        FlashboltError::InvalidAuthority
    );
    require!(
        pause_authority != Pubkey::default(),
        FlashboltError::InvalidAuthority
    );
    require!(
        admin != executor && admin != pause_authority && executor != pause_authority,
        FlashboltError::AuthoritiesNotIndependent
    );

    let config = &mut ctx.accounts.config;
    config.admin = admin;
    config.executor = executor;
    config.pause_authority = pause_authority;
    config.pending_admin = Pubkey::default();
    config.paused = false;
    config.bump = ctx.bumps.config;
    config.version = CONFIG_VERSION;
    config.reserved = [0u8; CONFIG_RESERVED_BYTES];

    emit!(ConfigInitialized {
        admin: config.admin,
        executor: config.executor,
        pause_authority: config.pause_authority,
        version: config.version,
    });

    Ok(())
}

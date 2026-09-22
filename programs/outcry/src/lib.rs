use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
        },
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
            TX_LOGS_FLAG, TX_MESSAGE_FLAG,
        },
    },
    anchor::{commit, delegate, ephemeral},
    consts::{DELEGATION_PROGRAM_ID, EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
};
use pyth_solana_receiver_sdk::{
    error::GetPriceError,
    price_update::{Price, PriceUpdateV2, VerificationLevel},
};

pub mod game;

declare_id!("D2rYtfu8x3CxJ89YoAUrWbfiMGhFbAtE9Hq8RNoJaUZt");

pub const MAX_PLAYERS: usize = 4;
pub const MAX_ROUNDS: u8 = 8;
pub const DEFAULT_ROUND_COUNT: u8 = 3;
pub const LEGACY_MATCH_SPACE: usize = 372;
pub const PREVIOUS_MATCH_SPACE: usize = 373;
pub const LEGACY_CURRENT_MATCH_SPACE: usize = 407;
pub const NO_ROUND: u8 = u8::MAX;
pub const MIN_PLAYERS_TO_START: u8 = 2;

pub const MATCH_WAITING: u8 = 0;
pub const MATCH_STARTED: u8 = 1;
pub const MATCH_FINISHED: u8 = 2;

pub const ROUND_OPEN: u8 = 0;
pub const ROUND_RESOLVED: u8 = 1;
pub const ROUND_SKIPPED: u8 = 3;
pub const ROUND_READY: u8 = 4;
pub const ROUND_TERMINAL: u8 = 5;

pub const SIDE_BUY: u8 = game::BUY;
pub const SIDE_SELL: u8 = game::SELL;
pub const ORACLE_MAX_AGE_SECONDS: i64 = game::DEFAULT_ORACLE_MAX_AGE_SECONDS;
pub const MAX_DEVIATION_BPS: u64 = game::DEFAULT_MAX_DEVIATION_BPS;

pub const MATCH_SEED: &[u8] = b"match_v2";
pub const RUNTIME_SEED: &[u8] = b"runtime";
pub const PRIVATE_QUOTE_SEED: &[u8] = b"quote";
pub const PRIVATE_INVENTORY_SEED: &[u8] = b"inventory";
pub const SESSION_SEED: &[u8] = b"session";
pub const ESCROW_SEED: &[u8] = b"escrow";

pub const SESSION_MAX_DURATION_SECONDS: i64 = 24 * 60 * 60;
pub const SESSION_ACTION_MASK: u8 = (game::SessionAction::OpenRfq as u8)
    | (game::SessionAction::SubmitQuote as u8)
    | (game::SessionAction::StartMatch as u8)
    | (game::SessionAction::SetupPrivateState as u8);

pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
pub const PYTH_PUSH_ORACLE_PROGRAM_ID: Pubkey =
    pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
pub const PYTH_SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];
pub const PYTH_SOL_USD_PUSH_FEED: Pubkey = pubkey!("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

const EPHEMERAL_PERMISSION_DISCRIMINATOR: u8 = 1;
const LEGACY_MATCH_DISCRIMINATOR: [u8; 8] = [236, 63, 169, 38, 15, 56, 196, 162];
const LEGACY_MATCH_SEED: &[u8] = b"match";
const LEGACY_MATCH_PIT_OFFSET: usize = 40;
const LEGACY_MATCH_NONCE_OFFSET: usize = 72;
const LEGACY_MATCH_STATUS_OFFSET: usize = 80;
const LEGACY_MATCH_CAPACITY_OFFSET: usize = 81;
const LEGACY_MATCH_PLAYER_COUNT_OFFSET: usize = 82;
const LEGACY_MATCH_CURRENT_ROUND_OFFSET: usize = 83;
const LEGACY_MATCH_PLAYERS_OFFSET: usize = 83;
const PREVIOUS_MATCH_PLAYERS_OFFSET: usize = 84;
const LEGACY_MATCH_RESULT_OFFSET: usize = 339;
const PREVIOUS_MATCH_RESULT_OFFSET: usize = 340;
const LEGACY_MATCH_ROUND_COUNT_OFFSET: usize = 373;

#[ephemeral]
#[program]
pub mod outcry {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    pub fn initialize_pit(
        ctx: Context<InitializePit>,
        pit_id: [u8; 32],
        capacity: u8,
    ) -> Result<()> {
        require!(
            capacity > 0 && capacity as usize <= MAX_PLAYERS,
            ErrorCode::InvalidPitCapacity
        );
        let pit = &mut ctx.accounts.pit;
        pit.authority = ctx.accounts.authority.key();
        pit.pit_id = pit_id;
        pit.capacity = capacity;
        pit.active_match = Pubkey::default();
        pit.bump = ctx.bumps.pit;
        Ok(())
    }

    pub fn create_match(ctx: Context<CreateMatch>, _match_nonce: u64) -> Result<()> {
        let pit = &mut ctx.accounts.pit;
        require!(
            pit.active_match == Pubkey::default(),
            ErrorCode::PitHasActiveMatch
        );

        let match_key = ctx.accounts.match_state.key();
        let match_state = &mut ctx.accounts.match_state;
        match_state.authority = ctx.accounts.authority.key();
        match_state.pit = pit.key();
        match_state.status = MATCH_WAITING;
        match_state.capacity = pit.capacity;
        match_state.player_count = 0;
        match_state.round_count = DEFAULT_ROUND_COUNT;
        match_state.players = [Pubkey::default(); MAX_PLAYERS];
        match_state.bump = ctx.bumps.match_state;

        let runtime = &mut ctx.accounts.runtime;
        runtime.match_key = match_key;
        runtime.round = 0;
        runtime.taker = Pubkey::default();
        runtime.side = SIDE_BUY;
        runtime.quantity_lots = 0;
        runtime.opened_at = 0;
        runtime.deadline = 0;
        runtime.quote_count = 0;
        runtime.status = ROUND_READY;
        runtime.oracle = Pubkey::default();
        runtime.oracle_price_e6 = 0;
        runtime.winning_dealer = Pubkey::default();
        runtime.clearing_price = 0;
        runtime.last_resolved_round = NO_ROUND;
        runtime.last_round_winner = Pubkey::default();
        runtime.finalized_at = 0;
        runtime.winner = Pubkey::default();
        runtime.final_scores_e6 = [0; MAX_PLAYERS];
        runtime.bump = ctx.bumps.runtime;
        pit.active_match = match_key;
        Ok(())
    }

    pub fn release_active_match(
        ctx: Context<ReleaseActiveMatch>,
        match_nonce: u64,
        force: bool,
    ) -> Result<()> {
        let pit_key = ctx.accounts.pit.key();
        let match_info = ctx.accounts.match_state.to_account_info();
        require_keys_eq!(
            ctx.accounts.pit.active_match,
            match_info.key(),
            ErrorCode::ActiveMatchMismatch
        );

        require!(
            *match_info.owner == crate::ID || *match_info.owner == DELEGATION_PROGRAM_ID,
            ErrorCode::InvalidMatchAccount
        );
        let data = match_info.try_borrow_data()?;
        if data.len() == MatchV2::SPACE && data.get(..8) == Some(MatchV2::DISCRIMINATOR) {
            validate_v2_match_for_release(&data, pit_key, match_info.key(), match_nonce, force)?;
        } else {
            validate_legacy_match_for_release(&data, pit_key, match_info.key(), force)?;
        }
        drop(data);

        ctx.accounts.pit.active_match = Pubkey::default();
        Ok(())
    }

    /// Copies a safe, waiting legacy match into the V2 PDA namespace.
    ///
    /// In-progress legacy matches stay readable and releasable through
    /// `release_active_match`; they are not silently rewritten because their
    /// per-round accounts cannot be represented by the reusable V2 runtime.
    pub fn migrate_legacy_match(ctx: Context<MigrateLegacyMatch>, match_nonce: u64) -> Result<()> {
        let legacy_key = ctx.accounts.legacy_match.key();
        require_keys_eq!(
            ctx.accounts.pit.active_match,
            legacy_key,
            ErrorCode::ActiveMatchMismatch
        );

        let legacy_info = ctx.accounts.legacy_match.to_account_info();
        require_keys_eq!(
            *legacy_info.owner,
            crate::ID,
            ErrorCode::InvalidMatchAccount
        );
        let legacy_data = legacy_info.try_borrow_data()?;
        let legacy = parse_legacy_match(&legacy_data)?;
        let (expected_legacy, _) = Pubkey::find_program_address(
            &[
                LEGACY_MATCH_SEED,
                ctx.accounts.pit.key().as_ref(),
                &legacy.match_nonce.to_le_bytes(),
            ],
            &crate::ID,
        );
        require_keys_eq!(expected_legacy, legacy_key, ErrorCode::InvalidMatchAccount);
        require_keys_eq!(
            legacy.pit,
            ctx.accounts.pit.key(),
            ErrorCode::InvalidMatchAccount
        );
        require!(
            legacy.match_nonce == match_nonce,
            ErrorCode::InvalidMatchAccount
        );
        require_keys_eq!(
            legacy.authority,
            ctx.accounts.authority.key(),
            ErrorCode::NotMatchHost
        );
        require!(
            legacy.status == MATCH_WAITING
                && legacy.current_round == 0
                && legacy.result == Pubkey::default(),
            ErrorCode::LegacyMigrationNotSafe
        );
        require!(
            legacy.capacity > 0
                && legacy.capacity as usize <= MAX_PLAYERS
                && legacy.capacity <= ctx.accounts.pit.capacity,
            ErrorCode::InvalidPitCapacity
        );
        require!(
            legacy.player_count <= legacy.capacity,
            ErrorCode::InvalidMatchAccount
        );
        drop(legacy_data);

        let match_key = ctx.accounts.match_state.key();
        let match_state = &mut ctx.accounts.match_state;
        match_state.authority = legacy.authority;
        match_state.pit = ctx.accounts.pit.key();
        match_state.status = MATCH_WAITING;
        match_state.capacity = legacy.capacity;
        match_state.player_count = legacy.player_count;
        match_state.round_count = if (1..=MAX_ROUNDS).contains(&legacy.round_count) {
            legacy.round_count
        } else {
            DEFAULT_ROUND_COUNT
        };
        match_state.players = legacy.players;
        match_state.bump = ctx.bumps.match_state;

        let runtime = &mut ctx.accounts.runtime;
        runtime.match_key = match_key;
        runtime.round = 0;
        runtime.taker = Pubkey::default();
        runtime.side = SIDE_BUY;
        runtime.quantity_lots = 0;
        runtime.opened_at = 0;
        runtime.deadline = 0;
        runtime.quote_count = 0;
        runtime.status = ROUND_READY;
        runtime.oracle = Pubkey::default();
        runtime.oracle_price_e6 = 0;
        runtime.winning_dealer = Pubkey::default();
        runtime.clearing_price = 0;
        runtime.last_resolved_round = NO_ROUND;
        runtime.last_round_winner = Pubkey::default();
        runtime.finalized_at = 0;
        runtime.winner = Pubkey::default();
        runtime.final_scores_e6 = [0; MAX_PLAYERS];
        runtime.bump = ctx.bumps.runtime;
        ctx.accounts.pit.active_match = match_key;
        Ok(())
    }

    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        ctx.accounts.match_state.join(ctx.accounts.player.key())
    }

    pub fn authorize_session(
        ctx: Context<AuthorizeSession>,
        session_key: Pubkey,
        expires_in_seconds: i64,
        action_mask: u8,
    ) -> Result<()> {
        require!(
            ctx.accounts.match_state.status != MATCH_FINISHED,
            ErrorCode::MatchFinished
        );
        require!(
            ctx.accounts
                .match_state
                .players
                .contains(&ctx.accounts.authority.key()),
            ErrorCode::NotAMatchPlayer
        );
        require!(session_key != Pubkey::default(), ErrorCode::InvalidSession);
        require!(
            expires_in_seconds > 0 && expires_in_seconds <= SESSION_MAX_DURATION_SECONDS,
            ErrorCode::InvalidSessionDuration
        );
        require!(
            action_mask != 0 && action_mask & !SESSION_ACTION_MASK == 0,
            ErrorCode::InvalidSessionActionMask
        );
        let now = Clock::get()?.unix_timestamp;
        let session = &mut ctx.accounts.session_grant;
        session.match_key = ctx.accounts.match_state.key();
        session.authority = ctx.accounts.authority.key();
        session.session_key = session_key;
        session.expires_at = now
            .checked_add(expires_in_seconds)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        session.action_mask = action_mask;
        session.revoked = false;
        session.bump = ctx.bumps.session_grant;
        Ok(())
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.session_grant.match_key,
            ctx.accounts.match_state.key(),
            ErrorCode::InvalidSession
        );
        ctx.accounts.session_grant.revoked = true;
        Ok(())
    }

    /// Extends an existing session without changing its signer or permissions.
    /// This is a wallet-authorized recovery action; routine gameplay remains
    /// session-signed.
    pub fn renew_session(ctx: Context<RenewSession>, expires_in_seconds: i64) -> Result<()> {
        require!(
            ctx.accounts.match_state.status != MATCH_FINISHED,
            ErrorCode::MatchFinished
        );
        require!(
            ctx.accounts
                .match_state
                .players
                .contains(&ctx.accounts.authority.key()),
            ErrorCode::NotAMatchPlayer
        );
        require_keys_eq!(
            ctx.accounts.session_grant.match_key,
            ctx.accounts.match_state.key(),
            ErrorCode::InvalidSession
        );
        require!(
            !ctx.accounts.session_grant.revoked,
            ErrorCode::InvalidSession
        );
        require!(
            expires_in_seconds > 0 && expires_in_seconds <= SESSION_MAX_DURATION_SECONDS,
            ErrorCode::InvalidSessionDuration
        );
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.session_grant.expires_at = now
            .checked_add(expires_in_seconds)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        Ok(())
    }

    pub fn start_match(ctx: Context<StartMatch>, round_count: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_session_grant(
            &ctx.accounts.session_grant,
            ctx.accounts.match_state.key(),
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
            now,
            game::SessionAction::StartMatch,
        )?;
        ctx.accounts
            .match_state
            .start(ctx.accounts.authority.key(), round_count)
    }

    pub fn initialize_oracle(ctx: Context<InitializeOracle>, feed_id: [u8; 32]) -> Result<()> {
        let clock = Clock::get()?;
        require!(feed_id == PYTH_SOL_USD_FEED_ID, ErrorCode::OracleInvalid);
        let (price_e6, published_at) = read_pyth_price(&ctx.accounts.price_feed, &clock)?;
        let oracle = &mut ctx.accounts.oracle;
        oracle.authority = ctx.accounts.authority.key();
        oracle.feed_id = feed_id;
        oracle.price_e6 = price_e6;
        oracle.published_at = published_at;
        oracle.bump = ctx.bumps.oracle;
        Ok(())
    }

    pub fn initialize_oracle_unpriced(
        ctx: Context<InitializeOracleUnpriced>,
        feed_id: [u8; 32],
    ) -> Result<()> {
        require!(feed_id == PYTH_SOL_USD_FEED_ID, ErrorCode::OracleInvalid);
        let oracle = &mut ctx.accounts.oracle;
        oracle.authority = ctx.accounts.authority.key();
        oracle.feed_id = feed_id;
        oracle.price_e6 = 0;
        oracle.published_at = 0;
        oracle.bump = ctx.bumps.oracle;
        Ok(())
    }

    pub fn update_oracle(ctx: Context<UpdateOracle>) -> Result<()> {
        let clock = Clock::get()?;
        let (price_e6, published_at) = read_pyth_price(&ctx.accounts.price_feed, &clock)?;
        require!(
            ctx.accounts.oracle.feed_id == PYTH_SOL_USD_FEED_ID,
            ErrorCode::OracleInvalid
        );
        ctx.accounts.oracle.price_e6 = price_e6;
        ctx.accounts.oracle.published_at = published_at;
        Ok(())
    }

    pub fn initialize_match_result(ctx: Context<InitializeMatchResult>) -> Result<()> {
        require!(
            ctx.accounts.match_state.status == MATCH_WAITING,
            ErrorCode::MatchNotJoinable
        );
        let result = &mut ctx.accounts.result;
        result.match_key = ctx.accounts.match_state.key();
        result.winner = Pubkey::default();
        result.final_scores_e6 = [0; MAX_PLAYERS];
        result.completed_at = 0;
        result.settled = false;
        result.bump = ctx.bumps.result;
        Ok(())
    }

    pub fn initialize_escrow(ctx: Context<InitializeEscrow>, payout_lamports: u64) -> Result<()> {
        require!(
            ctx.accounts.match_state.status == MATCH_WAITING,
            ErrorCode::MatchNotJoinable
        );
        require!(payout_lamports > 0, ErrorCode::InvalidEscrowAmount);
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            payout_lamports,
        )?;
        let escrow = &mut ctx.accounts.escrow;
        escrow.match_key = ctx.accounts.match_state.key();
        escrow.payout_lamports = payout_lamports;
        escrow.bump = ctx.bumps.escrow;
        Ok(())
    }

    pub fn initialize_private_quote(ctx: Context<InitializePrivateQuote>) -> Result<()> {
        require!(
            ctx.accounts.match_state.status == MATCH_WAITING,
            ErrorCode::MatchNotJoinable
        );
        require!(
            ctx.accounts
                .match_state
                .players
                .contains(&ctx.accounts.authority.key()),
            ErrorCode::NotAMatchPlayer
        );
        prefund_ephemeral_permission(
            ctx.accounts.system_program.key(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.quote.to_account_info(),
        )?;
        let quote = &mut ctx.accounts.quote;
        quote.match_key = ctx.accounts.match_state.key();
        quote.round = NO_ROUND;
        quote.authority = ctx.accounts.authority.key();
        quote.price_e6 = 0;
        quote.submitted_at = 0;
        quote.locked = false;
        quote.bump = ctx.bumps.quote;
        Ok(())
    }

    pub fn initialize_private_inventory(ctx: Context<InitializePrivateInventory>) -> Result<()> {
        require!(
            ctx.accounts.match_state.status == MATCH_WAITING,
            ErrorCode::MatchNotJoinable
        );
        require!(
            ctx.accounts
                .match_state
                .players
                .contains(&ctx.accounts.authority.key()),
            ErrorCode::NotAMatchPlayer
        );
        prefund_ephemeral_permission(
            ctx.accounts.system_program.key(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.inventory.to_account_info(),
        )?;
        let inventory = &mut ctx.accounts.inventory;
        inventory.match_key = ctx.accounts.match_state.key();
        inventory.authority = ctx.accounts.authority.key();
        inventory.sol_position_lots = 0;
        inventory.cash_e6 = 0;
        inventory.realized_pnl_e6 = 0;
        inventory.filled_notional_e6 = 0;
        inventory.bump = ctx.bumps.inventory;
        Ok(())
    }

    pub fn init_private_quote_permission(ctx: Context<PrivateQuotePermission>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_session_grant(
            &ctx.accounts.session_grant,
            ctx.accounts.match_state.key(),
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
            now,
            game::SessionAction::SetupPrivateState,
        )?;
        let bump = [ctx.accounts.quote.bump];
        let signers = [
            PRIVATE_QUOTE_SEED,
            ctx.accounts.quote.match_key.as_ref(),
            ctx.accounts.quote.authority.as_ref(),
            &bump,
        ];
        let members = private_members(
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
        );
        if private_permission_is_initialized(
            &ctx.accounts.permission.to_account_info(),
            ctx.accounts.quote.key(),
        )? {
            UpdateEphemeralPermissionCpi {
                payer: ctx.accounts.quote.to_account_info(),
                permissioned_account: ctx.accounts.quote.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: ctx.accounts.quote.to_account_info(),
                authority_is_signer: false,
                args: members,
            }
            .invoke_signed(&[&signers])?;
        } else {
            CreateEphemeralPermissionCpi {
                payer: ctx.accounts.quote.to_account_info(),
                permissioned_account: ctx.accounts.quote.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args: members,
            }
            .invoke_signed(&[&signers])?;
        }
        Ok(())
    }

    pub fn init_private_inventory_permission(
        ctx: Context<PrivateInventoryPermission>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_session_grant(
            &ctx.accounts.session_grant,
            ctx.accounts.match_state.key(),
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
            now,
            game::SessionAction::SetupPrivateState,
        )?;
        let bump = [ctx.accounts.inventory.bump];
        let signers = [
            PRIVATE_INVENTORY_SEED,
            ctx.accounts.inventory.match_key.as_ref(),
            ctx.accounts.inventory.authority.as_ref(),
            &bump,
        ];
        let members = private_members(
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
        );
        if private_permission_is_initialized(
            &ctx.accounts.permission.to_account_info(),
            ctx.accounts.inventory.key(),
        )? {
            UpdateEphemeralPermissionCpi {
                payer: ctx.accounts.inventory.to_account_info(),
                permissioned_account: ctx.accounts.inventory.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: ctx.accounts.inventory.to_account_info(),
                authority_is_signer: false,
                args: members,
            }
            .invoke_signed(&[&signers])?;
        } else {
            CreateEphemeralPermissionCpi {
                payer: ctx.accounts.inventory.to_account_info(),
                permissioned_account: ctx.accounts.inventory.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args: members,
            }
            .invoke_signed(&[&signers])?;
        }
        Ok(())
    }

    pub fn delegate_runtime(ctx: Context<DelegateRuntime>, match_key: Pubkey) -> Result<()> {
        let runtime = {
            let data = ctx.accounts.runtime.try_borrow_data()?;
            MatchRuntime::try_deserialize(&mut &data[..])?
        };
        require_keys_eq!(runtime.match_key, match_key, ErrorCode::InvalidRuntime);
        if ctx.accounts.runtime.to_account_info().owner != &ephemeral_rollups_sdk::id() {
            ctx.accounts.delegate_runtime(
                &ctx.accounts.payer,
                &[RUNTIME_SEED, match_key.as_ref()],
                DelegateConfig {
                    validator: ctx.accounts.validator.as_ref().map(|value| value.key()),
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }

    pub fn delegate_private_quote(
        ctx: Context<DelegatePrivateQuote>,
        match_key: Pubkey,
        dealer: Pubkey,
    ) -> Result<()> {
        let quote = {
            let data = ctx.accounts.quote.try_borrow_data()?;
            PrivateQuote::try_deserialize(&mut &data[..])?
        };
        require_keys_eq!(quote.match_key, match_key, ErrorCode::InvalidQuoteAccount);
        require_keys_eq!(quote.authority, dealer, ErrorCode::PrivateAuthorityMismatch);
        if ctx.accounts.quote.to_account_info().owner != &ephemeral_rollups_sdk::id() {
            ctx.accounts.delegate_quote(
                &ctx.accounts.payer,
                &[PRIVATE_QUOTE_SEED, match_key.as_ref(), dealer.as_ref()],
                DelegateConfig {
                    validator: ctx.accounts.validator.as_ref().map(|value| value.key()),
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }

    pub fn delegate_private_inventory(
        ctx: Context<DelegatePrivateInventory>,
        match_key: Pubkey,
        player: Pubkey,
    ) -> Result<()> {
        let inventory = {
            let data = ctx.accounts.inventory.try_borrow_data()?;
            PrivateInventory::try_deserialize(&mut &data[..])?
        };
        require_keys_eq!(inventory.match_key, match_key, ErrorCode::InventoryMismatch);
        require_keys_eq!(
            inventory.authority,
            player,
            ErrorCode::PrivateAuthorityMismatch
        );
        if ctx.accounts.inventory.to_account_info().owner != &ephemeral_rollups_sdk::id() {
            ctx.accounts.delegate_inventory(
                &ctx.accounts.payer,
                &[PRIVATE_INVENTORY_SEED, match_key.as_ref(), player.as_ref()],
                DelegateConfig {
                    validator: ctx.accounts.validator.as_ref().map(|value| value.key()),
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }

    pub fn open_rfq(
        ctx: Context<OpenRfq>,
        side: u8,
        quantity_lots: u64,
        quote_window_seconds: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_session_grant(
            &ctx.accounts.session_grant,
            ctx.accounts.match_state.key(),
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
            now,
            game::SessionAction::OpenRfq,
        )?;
        open_rfq_state(
            &ctx.accounts.match_state,
            &mut ctx.accounts.runtime,
            &ctx.accounts.oracle,
            ctx.accounts.match_state.key(),
            ctx.accounts.oracle.key(),
            ctx.accounts.authority.key(),
            side,
            quantity_lots,
            quote_window_seconds,
            now,
        )
    }

    pub fn submit_quote(ctx: Context<SubmitQuote>, price_e6: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_session_grant(
            &ctx.accounts.session_grant,
            ctx.accounts.match_state.key(),
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
            now,
            game::SessionAction::SubmitQuote,
        )?;
        submit_quote_state(
            &ctx.accounts.match_state,
            &mut ctx.accounts.runtime,
            &mut ctx.accounts.quote,
            ctx.accounts.authority.key(),
            price_e6,
            now,
        )
    }

    pub fn resolve_round(ctx: Context<ResolveRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let taker_inventory_key = ctx.accounts.taker_inventory.key();
        resolve_round_state(
            &ctx.accounts.match_state,
            &mut ctx.accounts.runtime,
            &mut ctx.accounts.taker_inventory,
            taker_inventory_key,
            ctx.remaining_accounts,
            now,
        )
    }

    pub fn skip_empty_round(ctx: Context<SkipEmptyRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        skip_empty_round_state(&ctx.accounts.match_state, &mut ctx.accounts.runtime, now)
    }

    pub fn advance_round(ctx: Context<AdvanceRound>) -> Result<()> {
        advance_round_state(&ctx.accounts.match_state, &mut ctx.accounts.runtime)
    }

    pub fn finalize_runtime(ctx: Context<FinalizeRuntime>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        map_game_result(game::validate_oracle(
            ctx.accounts.oracle.price_e6,
            ctx.accounts.oracle.published_at,
            now,
            ORACLE_MAX_AGE_SECONDS,
        ))?;
        require!(
            ctx.accounts.runtime.status == ROUND_TERMINAL,
            ErrorCode::RuntimeNotTerminal
        );
        require!(
            ctx.accounts.runtime.finalized_at == 0,
            ErrorCode::ScoresAlreadyFinalized
        );

        let mut seen = [false; MAX_PLAYERS];
        let mut winner = Pubkey::default();
        let mut winner_score = i128::MIN;
        for account_info in ctx.remaining_accounts.iter() {
            let inventory = Account::<PrivateInventory>::try_from(account_info)
                .map_err(|_| error!(ErrorCode::InventoryMismatch))?;
            require_keys_eq!(
                inventory.match_key,
                ctx.accounts.match_state.key(),
                ErrorCode::InventoryMismatch
            );
            let index = ctx
                .accounts
                .match_state
                .players
                .iter()
                .position(|player| player == &inventory.authority)
                .ok_or(error!(ErrorCode::InventoryMismatch))?;
            require!(!seen[index], ErrorCode::InventoryMismatch);
            let (expected, _) = Pubkey::find_program_address(
                &[
                    PRIVATE_INVENTORY_SEED,
                    ctx.accounts.match_state.key().as_ref(),
                    inventory.authority.as_ref(),
                ],
                &crate::ID,
            );
            require_keys_eq!(expected, inventory.key(), ErrorCode::InventoryMismatch);
            seen[index] = true;
            let value = game::Inventory {
                sol_position_lots: inventory.sol_position_lots,
                cash_e6: inventory.cash_e6,
                realized_pnl_e6: inventory.realized_pnl_e6,
                filled_notional_e6: inventory.filled_notional_e6,
            };
            let score = map_game_result(game::score_e6(
                value,
                ctx.accounts.oracle.price_e6,
                100,
                100,
            ))?;
            ctx.accounts.runtime.final_scores_e6[index] =
                i64::try_from(score).map_err(|_| error!(ErrorCode::ArithmeticOverflow))?;
            if score > winner_score
                || (score == winner_score && inventory.authority.to_bytes() < winner.to_bytes())
            {
                winner = inventory.authority;
                winner_score = score;
            }
        }
        require!(
            seen[..ctx.accounts.match_state.player_count as usize]
                .iter()
                .all(|value| *value),
            ErrorCode::InventoryMismatch
        );
        ctx.accounts.runtime.winner = winner;
        ctx.accounts.runtime.finalized_at = now;
        emit!(RuntimeFinalized {
            match_key: ctx.accounts.match_state.key(),
            winner,
            final_scores_e6: ctx.accounts.runtime.final_scores_e6,
        });
        Ok(())
    }

    pub fn scrub_private_quote(ctx: Context<ScrubPrivateQuote>) -> Result<()> {
        require_runtime_finalized(&ctx.accounts.runtime)?;
        ctx.accounts.quote.price_e6 = 0;
        ctx.accounts.quote.submitted_at = 0;
        ctx.accounts.quote.locked = false;
        close_quote_permission(
            &ctx.accounts.quote,
            &ctx.accounts.permission,
            &ctx.accounts.ephemeral_vault,
            &ctx.accounts.magic_program,
            &ctx.accounts.permission_program,
        )
    }

    pub fn scrub_private_inventory(ctx: Context<ScrubPrivateInventory>) -> Result<()> {
        require_runtime_finalized(&ctx.accounts.runtime)?;
        ctx.accounts.inventory.sol_position_lots = 0;
        ctx.accounts.inventory.cash_e6 = 0;
        ctx.accounts.inventory.realized_pnl_e6 = 0;
        ctx.accounts.inventory.filled_notional_e6 = 0;
        close_inventory_permission(
            &ctx.accounts.inventory,
            &ctx.accounts.permission,
            &ctx.accounts.ephemeral_vault,
            &ctx.accounts.magic_program,
            &ctx.accounts.permission_program,
        )
    }

    pub fn finalize_match(ctx: Context<FinalizeMatch>) -> Result<()> {
        require!(
            ctx.accounts.runtime.status == ROUND_TERMINAL && ctx.accounts.runtime.finalized_at != 0,
            ErrorCode::RuntimeNotFinalized
        );
        require!(
            ctx.accounts.result.completed_at == 0,
            ErrorCode::ScoresAlreadyFinalized
        );
        ctx.accounts.result.match_key = ctx.accounts.match_state.key();
        ctx.accounts.result.winner = ctx.accounts.runtime.winner;
        ctx.accounts.result.final_scores_e6 = ctx.accounts.runtime.final_scores_e6;
        ctx.accounts.result.completed_at = ctx.accounts.runtime.finalized_at;
        ctx.accounts.result.settled = false;
        ctx.accounts.match_state.status = MATCH_FINISHED;
        emit!(MatchFinalized {
            match_key: ctx.accounts.match_state.key(),
            winner: ctx.accounts.result.winner,
            completed_at: ctx.accounts.result.completed_at,
        });
        Ok(())
    }

    pub fn settle_match(ctx: Context<SettleMatch>) -> Result<()> {
        require!(
            ctx.accounts.match_state.status == MATCH_FINISHED,
            ErrorCode::MatchNotFinished
        );
        require_keys_eq!(
            ctx.accounts.result.match_key,
            ctx.accounts.match_state.key(),
            ErrorCode::SettlementMismatch
        );
        require_keys_eq!(
            ctx.accounts.escrow.match_key,
            ctx.accounts.match_state.key(),
            ErrorCode::EscrowMismatch
        );
        require!(
            ctx.accounts.result.completed_at != 0,
            ErrorCode::ResultNotFinalized
        );
        require!(!ctx.accounts.result.settled, ErrorCode::AlreadySettled);
        require_keys_eq!(
            ctx.accounts.winner.key(),
            ctx.accounts.result.winner,
            ErrorCode::WrongWinner
        );
        let payout = ctx.accounts.escrow.payout_lamports;
        let escrow_lamports = ctx.accounts.escrow.to_account_info().lamports();
        require!(
            escrow_lamports >= payout,
            ErrorCode::EscrowInsufficientFunds
        );
        let remaining = escrow_lamports
            .checked_sub(payout)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        let winner_balance = ctx
            .accounts
            .winner
            .to_account_info()
            .lamports()
            .checked_add(payout)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        **ctx
            .accounts
            .escrow
            .to_account_info()
            .try_borrow_mut_lamports()? = remaining;
        **ctx
            .accounts
            .winner
            .to_account_info()
            .try_borrow_mut_lamports()? = winner_balance;
        ctx.accounts.result.settled = true;
        Ok(())
    }

    pub fn commit_runtime(ctx: Context<CommitRuntime>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[ctx.accounts.runtime.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn commit_private_quote(ctx: Context<CommitPrivateQuote>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[ctx.accounts.quote.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn commit_private_inventory(ctx: Context<CommitPrivateInventory>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[ctx.accounts.inventory.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn undelegate_runtime(ctx: Context<UndelegateRuntime>) -> Result<()> {
        require_runtime_finalized(&ctx.accounts.runtime)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[ctx.accounts.runtime.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn undelegate_private_quote(ctx: Context<UndelegatePrivateQuote>) -> Result<()> {
        require_quote_scrubbed(&ctx.accounts.quote)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[ctx.accounts.quote.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn undelegate_private_inventory(ctx: Context<UndelegatePrivateInventory>) -> Result<()> {
        require_inventory_scrubbed(&ctx.accounts.inventory)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[ctx.accounts.inventory.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

fn map_game_result<T>(result: std::result::Result<T, game::GameError>) -> Result<T> {
    result.map_err(|error| {
        error!(match error {
            game::GameError::InvalidSide => ErrorCode::InvalidSide,
            game::GameError::InvalidQuantity => ErrorCode::InvalidQuantity,
            game::GameError::InvalidPrice => ErrorCode::OracleInvalid,
            game::GameError::OracleStale => ErrorCode::OracleStale,
            game::GameError::OracleInvalid => ErrorCode::OracleInvalid,
            game::GameError::QuoteOutsideBand => ErrorCode::QuoteOutsideBand,
            game::GameError::NoQuotes => ErrorCode::NotEnoughQuotes,
            game::GameError::ArithmeticOverflow => ErrorCode::ArithmeticOverflow,
            game::GameError::InvalidSession => ErrorCode::InvalidSession,
            game::GameError::SessionExpired => ErrorCode::SessionExpired,
            game::GameError::ActionNotAllowed => ErrorCode::SessionActionNotAllowed,
        })
    })
}

#[derive(Clone, Copy)]
struct LegacyMatchSnapshot {
    authority: Pubkey,
    pit: Pubkey,
    match_nonce: u64,
    status: u8,
    capacity: u8,
    player_count: u8,
    current_round: u8,
    round_count: u8,
    players: [Pubkey; MAX_PLAYERS],
    result: Pubkey,
}

fn parse_legacy_match(data: &[u8]) -> Result<LegacyMatchSnapshot> {
    require!(
        matches!(
            data.len(),
            LEGACY_MATCH_SPACE | PREVIOUS_MATCH_SPACE | LEGACY_CURRENT_MATCH_SPACE
        ),
        ErrorCode::InvalidMatchAccount
    );
    require!(
        data.get(..8) == Some(LEGACY_MATCH_DISCRIMINATOR.as_slice()),
        ErrorCode::InvalidMatchAccount
    );

    let players_offset = if data.len() == LEGACY_MATCH_SPACE {
        LEGACY_MATCH_PLAYERS_OFFSET
    } else {
        PREVIOUS_MATCH_PLAYERS_OFFSET
    };
    let mut players = [Pubkey::default(); MAX_PLAYERS];
    for (index, player) in players.iter_mut().enumerate() {
        *player = read_layout_pubkey(data, players_offset + index * 32)?;
    }
    let result_offset = if data.len() == LEGACY_MATCH_SPACE {
        LEGACY_MATCH_RESULT_OFFSET
    } else {
        PREVIOUS_MATCH_RESULT_OFFSET
    };

    Ok(LegacyMatchSnapshot {
        authority: read_layout_pubkey(data, 8)?,
        pit: read_layout_pubkey(data, LEGACY_MATCH_PIT_OFFSET)?,
        match_nonce: read_layout_u64(data, LEGACY_MATCH_NONCE_OFFSET)?,
        status: data[LEGACY_MATCH_STATUS_OFFSET],
        capacity: data[LEGACY_MATCH_CAPACITY_OFFSET],
        player_count: data[LEGACY_MATCH_PLAYER_COUNT_OFFSET],
        current_round: if data.len() == LEGACY_MATCH_SPACE {
            0
        } else {
            data[LEGACY_MATCH_CURRENT_ROUND_OFFSET]
        },
        round_count: if data.len() == LEGACY_CURRENT_MATCH_SPACE {
            data[LEGACY_MATCH_ROUND_COUNT_OFFSET]
        } else {
            DEFAULT_ROUND_COUNT
        },
        players,
        result: read_layout_pubkey(data, result_offset)?,
    })
}

fn read_layout_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes = data
        .get(offset..offset + 32)
        .ok_or_else(|| error!(ErrorCode::InvalidMatchAccount))?;
    Ok(Pubkey::new_from_array(
        bytes
            .try_into()
            .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
    ))
}

fn read_layout_u64(data: &[u8], offset: usize) -> Result<u64> {
    let bytes = data
        .get(offset..offset + 8)
        .ok_or_else(|| error!(ErrorCode::InvalidMatchAccount))?;
    Ok(u64::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
    ))
}

fn validate_v2_match_for_release(
    data: &[u8],
    pit: Pubkey,
    match_key: Pubkey,
    match_nonce: u64,
    force: bool,
) -> Result<()> {
    require!(data.len() == MatchV2::SPACE, ErrorCode::InvalidMatchAccount);
    require!(
        data.get(..8) == Some(MatchV2::DISCRIMINATOR),
        ErrorCode::InvalidMatchAccount
    );
    require_keys_eq!(
        read_layout_pubkey(data, 40)?,
        pit,
        ErrorCode::InvalidMatchAccount
    );
    let (expected_match, _) = Pubkey::find_program_address(
        &[MATCH_SEED, pit.as_ref(), &match_nonce.to_le_bytes()],
        &crate::ID,
    );
    require_keys_eq!(expected_match, match_key, ErrorCode::InvalidMatchAccount);
    if !force {
        let status = data[72];
        let player_count = data[74];
        require!(
            status == MATCH_FINISHED || (status == MATCH_WAITING && player_count == 0),
            ErrorCode::MatchNotReleasable
        );
    }
    Ok(())
}

fn validate_legacy_match_for_release(
    data: &[u8],
    pit: Pubkey,
    match_key: Pubkey,
    force: bool,
) -> Result<()> {
    let legacy = parse_legacy_match(data)?;
    require_keys_eq!(legacy.pit, pit, ErrorCode::InvalidMatchAccount);
    let (expected_match, _) = Pubkey::find_program_address(
        &[
            LEGACY_MATCH_SEED,
            pit.as_ref(),
            &legacy.match_nonce.to_le_bytes(),
        ],
        &crate::ID,
    );
    require_keys_eq!(expected_match, match_key, ErrorCode::InvalidMatchAccount);

    if !force {
        require!(
            match_can_be_released(legacy.status, legacy.current_round, legacy.result),
            ErrorCode::MatchNotReleasable
        );
    }
    Ok(())
}

fn match_can_be_released(status: u8, current_round: u8, result: Pubkey) -> bool {
    status == MATCH_FINISHED
        || ((status == MATCH_WAITING || status == MATCH_STARTED)
            && current_round == 0
            && result == Pubkey::default())
}

fn validate_session_grant(
    grant: &SessionGrant,
    match_key: Pubkey,
    authority: Pubkey,
    session_key: Pubkey,
    now: i64,
    action: game::SessionAction,
) -> Result<()> {
    require_keys_eq!(grant.match_key, match_key, ErrorCode::InvalidSession);
    require_keys_eq!(grant.authority, authority, ErrorCode::InvalidSession);
    require_keys_eq!(grant.session_key, session_key, ErrorCode::InvalidSession);
    map_game_result(game::validate_session(
        game::SessionGrant {
            match_key: grant.match_key,
            authority: grant.authority,
            expires_at: grant.expires_at,
            action_mask: grant.action_mask,
            revoked: grant.revoked,
        },
        match_key,
        authority,
        now,
        action,
    ))
}

fn read_pyth_price(price_update: &UncheckedAccount, clock: &Clock) -> Result<(i64, i64)> {
    let shard_zero = [0u8; 2];
    let (derived_push_feed, _) = Pubkey::find_program_address(
        &[&shard_zero, PYTH_SOL_USD_FEED_ID.as_ref()],
        &PYTH_PUSH_ORACLE_PROGRAM_ID,
    );
    require_keys_eq!(
        derived_push_feed,
        PYTH_SOL_USD_PUSH_FEED,
        ErrorCode::OracleInvalid
    );
    require_keys_eq!(
        price_update.key(),
        derived_push_feed,
        ErrorCode::OracleInvalid
    );
    require_keys_eq!(
        *price_update.owner,
        PYTH_RECEIVER_PROGRAM_ID,
        ErrorCode::OracleInvalid
    );
    let account_info = price_update.to_account_info();
    let data = account_info.try_borrow_data()?;
    let mut data_slice = data.as_ref();
    let price_update = PriceUpdateV2::try_deserialize_unchecked(&mut data_slice)
        .map_err(|_| error!(ErrorCode::OracleInvalid))?;
    require!(
        price_update.verification_level == VerificationLevel::Full,
        ErrorCode::OracleInvalid
    );
    let price = price_update
        .get_price_unchecked(&PYTH_SOL_USD_FEED_ID)
        .map_err(|_: GetPriceError| error!(ErrorCode::OracleInvalid))?;
    require!(
        price.publish_time <= clock.unix_timestamp,
        ErrorCode::OracleInvalid
    );
    let age = clock
        .unix_timestamp
        .checked_sub(price.publish_time)
        .ok_or(ErrorCode::OracleInvalid)?;
    require!(age <= ORACLE_MAX_AGE_SECONDS, ErrorCode::OracleStale);
    Ok((magicblock_price_e6(price)?, price.publish_time))
}

fn magicblock_price_e6(price: Price) -> Result<i64> {
    require!(
        (-18..=18).contains(&price.exponent),
        ErrorCode::OracleInvalid
    );
    require!(price.price > 0, ErrorCode::OracleInvalid);
    let scale = price.exponent + 6;
    let magnitude = i128::from(price.price);
    let value = if scale >= 0 {
        magnitude
            .checked_mul(pow10(scale as u32)?)
            .ok_or(ErrorCode::ArithmeticOverflow)?
    } else {
        magnitude / pow10((-scale) as u32)?
    };
    require!(
        value > 0 && value <= i128::from(i64::MAX),
        ErrorCode::OracleInvalid
    );
    i64::try_from(value).map_err(|_| error!(ErrorCode::ArithmeticOverflow))
}

fn pow10(exponent: u32) -> Result<i128> {
    (0..exponent).try_fold(1_i128, |value, _| {
        value
            .checked_mul(10)
            .ok_or(error!(ErrorCode::ArithmeticOverflow))
    })
}

fn open_rfq_state(
    match_state: &MatchV2,
    runtime: &mut MatchRuntime,
    oracle: &OraclePrice,
    match_key: Pubkey,
    oracle_key: Pubkey,
    taker: Pubkey,
    side: u8,
    quantity_lots: u64,
    quote_window_seconds: i64,
    now: i64,
) -> Result<()> {
    require!(
        match_state.status == MATCH_STARTED,
        ErrorCode::MatchNotStarted
    );
    require!(
        match_state.round_count > 0 && match_state.round_count <= MAX_ROUNDS,
        ErrorCode::InvalidRoundCount
    );
    require!(
        runtime.round < match_state.round_count,
        ErrorCode::MatchFinished
    );
    require!(runtime.status == ROUND_READY, ErrorCode::RoundNotOpen);
    require!(
        quote_window_seconds > 0 && quote_window_seconds <= 30,
        ErrorCode::InvalidQuoteWindow
    );
    map_game_result(game::validate_side(side))?;
    map_game_result(game::validate_quantity(quantity_lots))?;
    map_game_result(game::validate_oracle(
        oracle.price_e6,
        oracle.published_at,
        now,
        ORACLE_MAX_AGE_SECONDS,
    ))?;
    let taker_index = match_taker_index(match_state, runtime.round)?;
    require_keys_eq!(
        taker,
        match_state.players[taker_index],
        ErrorCode::NotCurrentTaker
    );
    runtime.taker = taker;
    runtime.side = side;
    runtime.quantity_lots = quantity_lots;
    runtime.opened_at = now;
    runtime.deadline = now
        .checked_add(quote_window_seconds)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    runtime.quote_count = 0;
    runtime.status = ROUND_OPEN;
    runtime.oracle = oracle_key;
    runtime.oracle_price_e6 = oracle.price_e6;
    runtime.winning_dealer = Pubkey::default();
    runtime.clearing_price = 0;
    emit!(RfqOpened {
        match_key,
        round: runtime.round,
        taker,
        side,
        quantity_lots,
        deadline: runtime.deadline,
        oracle_price_e6: runtime.oracle_price_e6,
    });
    Ok(())
}

fn submit_quote_state(
    match_state: &MatchV2,
    runtime: &mut MatchRuntime,
    quote: &mut PrivateQuote,
    dealer: Pubkey,
    price_e6: i64,
    now: i64,
) -> Result<()> {
    require!(runtime.status == ROUND_OPEN, ErrorCode::RoundNotOpen);
    map_game_result(game::validate_quantity(runtime.quantity_lots))?;
    require!(now <= runtime.deadline, ErrorCode::QuoteDeadlinePassed);
    require_keys_eq!(
        quote.match_key,
        runtime.match_key,
        ErrorCode::InvalidQuoteAccount
    );
    require_keys_eq!(quote.authority, dealer, ErrorCode::QuoteNotAuthorized);
    require!(dealer != runtime.taker, ErrorCode::DealerIsTaker);
    require!(
        match_state.players.contains(&dealer),
        ErrorCode::NotAMatchPlayer
    );
    require!(
        !(quote.round == runtime.round && quote.locked),
        ErrorCode::QuoteLocked
    );
    map_game_result(game::validate_quote(
        price_e6,
        runtime.oracle_price_e6,
        MAX_DEVIATION_BPS,
    ))?;
    quote.round = runtime.round;
    quote.price_e6 = price_e6;
    quote.submitted_at = now;
    quote.locked = true;
    runtime.quote_count = runtime
        .quote_count
        .checked_add(1)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    Ok(())
}

fn resolve_round_state<'info>(
    match_state: &MatchV2,
    runtime: &mut MatchRuntime,
    taker_inventory: &mut PrivateInventory,
    taker_inventory_key: Pubkey,
    remaining_accounts: &'info [AccountInfo<'info>],
    now: i64,
) -> Result<()> {
    require!(runtime.status == ROUND_OPEN, ErrorCode::RoundNotOpen);
    map_game_result(game::validate_quantity(runtime.quantity_lots))?;
    require!(
        now >= runtime.deadline
            || runtime.quote_count >= match_state.player_count.saturating_sub(1),
        ErrorCode::DeadlineNotReached
    );
    let mut candidates = Vec::with_capacity(remaining_accounts.len());
    let mut inventory_accounts = Vec::new();
    for account_info in remaining_accounts {
        let data = account_info.try_borrow_data()?;
        let discriminator = data
            .get(..8)
            .ok_or(error!(ErrorCode::InvalidQuoteAccount))?;
        if discriminator == PrivateInventory::DISCRIMINATOR {
            inventory_accounts.push(account_info);
            continue;
        }
        require!(
            discriminator == PrivateQuote::DISCRIMINATOR,
            ErrorCode::InvalidQuoteAccount
        );
        drop(data);
        let quote = Account::<PrivateQuote>::try_from(account_info)
            .map_err(|_| error!(ErrorCode::InvalidQuoteAccount))?;
        require_keys_eq!(
            quote.match_key,
            runtime.match_key,
            ErrorCode::InvalidQuoteAccount
        );
        require!(quote.authority != runtime.taker, ErrorCode::DealerIsTaker);
        require!(
            match_state.players.contains(&quote.authority),
            ErrorCode::NotAMatchPlayer
        );
        let (expected_quote, _) = Pubkey::find_program_address(
            &[
                PRIVATE_QUOTE_SEED,
                runtime.match_key.as_ref(),
                quote.authority.as_ref(),
            ],
            &crate::ID,
        );
        require_keys_eq!(quote.key(), expected_quote, ErrorCode::InvalidQuoteAccount);
        // Reusable quote accounts retain their last finalized round until the
        // dealer submits again. Stale or unlocked state is inert, never a
        // candidate for the current round.
        if quote.round != runtime.round || !quote.locked {
            continue;
        }
        require!(
            !candidates
                .iter()
                .any(|candidate: &game::QuoteCandidate| candidate.dealer == quote.authority),
            ErrorCode::InvalidQuoteAccount
        );
        candidates.push(game::QuoteCandidate {
            dealer: quote.authority,
            price_e6: quote.price_e6,
        });
    }
    require!(
        candidates.len() == runtime.quote_count as usize,
        ErrorCode::QuoteCountMismatch
    );
    require!(!candidates.is_empty(), ErrorCode::NotEnoughQuotes);
    let winner = map_game_result(game::select_winner(runtime.side, &candidates))?;
    let (expected_winner_inventory, _) = Pubkey::find_program_address(
        &[
            PRIVATE_INVENTORY_SEED,
            runtime.match_key.as_ref(),
            winner.dealer.as_ref(),
        ],
        &crate::ID,
    );
    let winning_inventory_info = inventory_accounts
        .into_iter()
        .find(|account_info| account_info.key() == expected_winner_inventory)
        .ok_or(error!(ErrorCode::InventoryMismatch))?;
    let mut winning_inventory = Account::<PrivateInventory>::try_from(winning_inventory_info)
        .map_err(|_| error!(ErrorCode::InventoryMismatch))?;
    require_keys_eq!(
        taker_inventory.match_key,
        runtime.match_key,
        ErrorCode::InventoryMismatch
    );
    require_keys_eq!(
        taker_inventory.authority,
        runtime.taker,
        ErrorCode::InventoryMismatch
    );
    let (expected_taker_inventory, _) = Pubkey::find_program_address(
        &[
            PRIVATE_INVENTORY_SEED,
            runtime.match_key.as_ref(),
            runtime.taker.as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(
        taker_inventory_key,
        expected_taker_inventory,
        ErrorCode::InventoryMismatch
    );
    require_keys_eq!(
        winning_inventory.match_key,
        runtime.match_key,
        ErrorCode::InventoryMismatch
    );
    require_keys_eq!(
        winning_inventory.authority,
        winner.dealer,
        ErrorCode::InventoryMismatch
    );
    require!(
        taker_inventory_key != winning_inventory.key(),
        ErrorCode::InventoryMismatch
    );
    let mut taker = game::Inventory {
        sol_position_lots: taker_inventory.sol_position_lots,
        cash_e6: taker_inventory.cash_e6,
        realized_pnl_e6: taker_inventory.realized_pnl_e6,
        filled_notional_e6: taker_inventory.filled_notional_e6,
    };
    let mut dealer = game::Inventory {
        sol_position_lots: winning_inventory.sol_position_lots,
        cash_e6: winning_inventory.cash_e6,
        realized_pnl_e6: winning_inventory.realized_pnl_e6,
        filled_notional_e6: winning_inventory.filled_notional_e6,
    };
    map_game_result(game::apply_fill(
        &mut taker,
        &mut dealer,
        game::Fill {
            side: runtime.side,
            quantity_lots: runtime.quantity_lots,
            price_e6: winner.price_e6,
        },
    ))?;
    taker_inventory.sol_position_lots = taker.sol_position_lots;
    taker_inventory.cash_e6 = taker.cash_e6;
    taker_inventory.realized_pnl_e6 = taker.realized_pnl_e6;
    taker_inventory.filled_notional_e6 = taker.filled_notional_e6;
    winning_inventory.sol_position_lots = dealer.sol_position_lots;
    winning_inventory.cash_e6 = dealer.cash_e6;
    winning_inventory.realized_pnl_e6 = dealer.realized_pnl_e6;
    winning_inventory.filled_notional_e6 = dealer.filled_notional_e6;
    runtime.status = ROUND_RESOLVED;
    runtime.winning_dealer = winner.dealer;
    runtime.clearing_price = winner.price_e6;
    runtime.last_resolved_round = runtime.round;
    runtime.last_round_winner = winner.dealer;
    emit!(RoundResolved {
        match_key: runtime.match_key,
        round: runtime.round,
        taker: runtime.taker,
        side: runtime.side,
        quantity_lots: runtime.quantity_lots,
        winning_dealer: winner.dealer,
        clearing_price: winner.price_e6,
    });
    Ok(())
}

fn skip_empty_round_state(
    match_state: &MatchV2,
    runtime: &mut MatchRuntime,
    now: i64,
) -> Result<()> {
    require!(
        match_state.status == MATCH_STARTED,
        ErrorCode::MatchNotStarted
    );
    require!(runtime.status == ROUND_OPEN, ErrorCode::RoundNotOpen);
    require!(now >= runtime.deadline, ErrorCode::DeadlineNotReached);
    require!(runtime.quote_count == 0, ErrorCode::EmptyRoundRequired);
    runtime.status = ROUND_SKIPPED;
    emit!(EmptyRoundSkipped {
        match_key: runtime.match_key,
        round: runtime.round,
        deadline: runtime.deadline,
    });
    Ok(())
}

fn advance_round_state(match_state: &MatchV2, runtime: &mut MatchRuntime) -> Result<()> {
    require!(
        runtime.status == ROUND_RESOLVED || runtime.status == ROUND_SKIPPED,
        ErrorCode::RoundNotResolved
    );
    require!(
        match_state.status == MATCH_STARTED,
        ErrorCode::MatchFinished
    );
    require!(
        match_state.round_count > 0 && match_state.round_count <= MAX_ROUNDS,
        ErrorCode::InvalidRoundCount
    );
    let next_round = runtime
        .round
        .checked_add(1)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    if next_round >= match_state.round_count {
        runtime.status = ROUND_TERMINAL;
        return Ok(());
    }
    runtime.round = next_round;
    runtime.taker = Pubkey::default();
    runtime.side = SIDE_BUY;
    runtime.quantity_lots = 0;
    runtime.opened_at = 0;
    runtime.deadline = 0;
    runtime.quote_count = 0;
    runtime.status = ROUND_READY;
    runtime.oracle = Pubkey::default();
    runtime.oracle_price_e6 = 0;
    runtime.winning_dealer = Pubkey::default();
    runtime.clearing_price = 0;
    Ok(())
}

fn match_taker_index(match_state: &MatchV2, round: u8) -> Result<usize> {
    let player_count = match_state.player_count as usize;
    require!(
        player_count > 0 && player_count <= MAX_PLAYERS,
        ErrorCode::NotEnoughPlayers
    );
    let host_index = match_state.players[..player_count]
        .iter()
        .position(|player| *player == match_state.authority)
        .unwrap_or(0);
    Ok((host_index + round as usize) % player_count)
}

fn require_runtime_finalized(runtime: &MatchRuntime) -> Result<()> {
    require!(
        runtime.status == ROUND_TERMINAL,
        ErrorCode::RuntimeNotTerminal
    );
    require!(runtime.finalized_at != 0, ErrorCode::RuntimeNotFinalized);
    Ok(())
}

fn require_quote_scrubbed(quote: &PrivateQuote) -> Result<()> {
    require!(
        quote.price_e6 == 0 && quote.submitted_at == 0 && !quote.locked,
        ErrorCode::PrivateStateNotScrubbed
    );
    Ok(())
}

fn require_inventory_scrubbed(inventory: &PrivateInventory) -> Result<()> {
    require!(
        inventory.sol_position_lots == 0
            && inventory.cash_e6 == 0
            && inventory.realized_pnl_e6 == 0
            && inventory.filled_notional_e6 == 0,
        ErrorCode::PrivateStateNotScrubbed
    );
    Ok(())
}

fn prefund_ephemeral_permission<'info>(
    system_program: Pubkey,
    authority: AccountInfo<'info>,
    private_account: AccountInfo<'info>,
) -> Result<()> {
    transfer(
        CpiContext::new(
            system_program,
            Transfer {
                from: authority,
                to: private_account,
            },
        ),
        ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32),
    )?;
    Ok(())
}

fn private_permission_is_initialized(
    permission: &AccountInfo,
    permissioned_account: Pubkey,
) -> Result<bool> {
    let data = permission.try_borrow_data()?;
    if data.is_empty() {
        return Ok(false);
    }
    require_keys_eq!(
        *permission.owner,
        PERMISSION_PROGRAM_ID,
        ErrorCode::InvalidPrivatePermission
    );
    require!(
        is_valid_private_permission_data(&data, permissioned_account),
        ErrorCode::InvalidPrivatePermission
    );
    Ok(true)
}

fn is_valid_private_permission_data(data: &[u8], permissioned_account: Pubkey) -> bool {
    if data.len() < EphemeralPermission::size_of(1) {
        return false;
    }
    let Ok(permission) = EphemeralPermission::from_bytes(data) else {
        return false;
    };
    permission.discriminator == EPHEMERAL_PERMISSION_DISCRIMINATOR
        && permission.permissioned_account == permissioned_account
        && permission.private
        && !permission.members.is_empty()
}

fn private_members(authority: Pubkey, session_key: Pubkey) -> EphemeralMembersArgs {
    EphemeralMembersArgs {
        is_private: true,
        members: vec![
            Member {
                flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                pubkey: authority,
            },
            Member {
                flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                pubkey: session_key,
            },
        ],
    }
}

fn close_quote_permission<'info>(
    quote: &Account<'info, PrivateQuote>,
    permission: &UncheckedAccount<'info>,
    ephemeral_vault: &UncheckedAccount<'info>,
    magic_program: &UncheckedAccount<'info>,
    permission_program: &UncheckedAccount<'info>,
) -> Result<()> {
    if permission.to_account_info().data_is_empty() {
        return Ok(());
    }
    let bump = [quote.bump];
    let signers = [
        PRIVATE_QUOTE_SEED,
        quote.match_key.as_ref(),
        quote.authority.as_ref(),
        &bump,
    ];
    CloseEphemeralPermissionCpi {
        payer: quote.to_account_info(),
        permissioned_account: quote.to_account_info(),
        permission: permission.to_account_info(),
        vault: ephemeral_vault.to_account_info(),
        magic_program: magic_program.to_account_info(),
        permission_program: permission_program.to_account_info(),
        authority: quote.to_account_info(),
        authority_is_signer: false,
    }
    .invoke_signed(&[&signers])?;
    Ok(())
}

fn close_inventory_permission<'info>(
    inventory: &Account<'info, PrivateInventory>,
    permission: &UncheckedAccount<'info>,
    ephemeral_vault: &UncheckedAccount<'info>,
    magic_program: &UncheckedAccount<'info>,
    permission_program: &UncheckedAccount<'info>,
) -> Result<()> {
    if permission.to_account_info().data_is_empty() {
        return Ok(());
    }
    let bump = [inventory.bump];
    let signers = [
        PRIVATE_INVENTORY_SEED,
        inventory.match_key.as_ref(),
        inventory.authority.as_ref(),
        &bump,
    ];
    CloseEphemeralPermissionCpi {
        payer: inventory.to_account_info(),
        permissioned_account: inventory.to_account_info(),
        permission: permission.to_account_info(),
        vault: ephemeral_vault.to_account_info(),
        magic_program: magic_program.to_account_info(),
        permission_program: permission_program.to_account_info(),
        authority: inventory.to_account_info(),
        authority_is_signer: false,
    }
    .invoke_signed(&[&signers])?;
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize {}

#[derive(Accounts)]
#[instruction(pit_id: [u8; 32])]
pub struct InitializePit<'info> {
    #[account(
        init,
        payer = authority,
        space = PitConfig::SPACE,
        seeds = [b"pit", pit_id.as_ref()],
        bump,
    )]
    pub pit: Account<'info, PitConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_nonce: u64)]
pub struct CreateMatch<'info> {
    #[account(mut, has_one = authority)]
    pub pit: Account<'info, PitConfig>,
    #[account(
        init,
        payer = authority,
        space = MatchV2::SPACE,
        seeds = [MATCH_SEED, pit.key().as_ref(), &match_nonce.to_le_bytes()],
        bump,
    )]
    pub match_state: Account<'info, MatchV2>,
    #[account(
        init,
        payer = authority,
        space = MatchRuntime::SPACE,
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_nonce: u64)]
pub struct ReleaseActiveMatch<'info> {
    #[account(mut, has_one = authority)]
    pub pit: Account<'info, PitConfig>,
    /// CHECK: the handler validates V2 or legacy ownership, discriminator, layout, and PDA.
    pub match_state: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(match_nonce: u64)]
pub struct MigrateLegacyMatch<'info> {
    #[account(mut, has_one = authority)]
    pub pit: Account<'info, PitConfig>,
    /// CHECK: the handler validates the legacy owner, discriminator, layout, and PDA.
    pub legacy_match: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = MatchV2::SPACE,
        seeds = [MATCH_SEED, pit.key().as_ref(), &match_nonce.to_le_bytes()],
        bump,
    )]
    pub match_state: Account<'info, MatchV2>,
    #[account(
        init,
        payer = authority,
        space = MatchRuntime::SPACE,
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(mut)]
    pub match_state: Account<'info, MatchV2>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(session_key: Pubkey, _expires_in_seconds: i64, _action_mask: u8)]
pub struct AuthorizeSession<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        init,
        payer = authority,
        space = SessionGrant::SPACE,
        seeds = [
            SESSION_SEED,
            match_state.key().as_ref(),
            authority.key().as_ref(),
            session_key.as_ref()
        ],
        bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        has_one = authority,
        seeds = [
            SESSION_SEED,
            session_grant.match_key.as_ref(),
            authority.key().as_ref(),
            session_grant.session_key.as_ref()
        ],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RenewSession<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        has_one = authority,
        seeds = [
            SESSION_SEED,
            match_state.key().as_ref(),
            authority.key().as_ref(),
            session_grant.session_key.as_ref()
        ],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct StartMatch<'info> {
    #[account(mut)]
    pub match_state: Account<'info, MatchV2>,
    /// CHECK: bound to the session grant and checked against MatchV2.authority.
    pub authority: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [
            SESSION_SEED,
            match_state.key().as_ref(),
            authority.key().as_ref(),
            session_signer.key().as_ref()
        ],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct InitializeOracle<'info> {
    #[account(
        init,
        payer = authority,
        space = OraclePrice::SPACE,
        seeds = [b"oracle", feed_id.as_ref()],
        bump,
    )]
    pub oracle: Account<'info, OraclePrice>,
    /// CHECK: exact sponsored Pyth push-feed PDA; owner, verification level, feed id, and freshness are validated by read_pyth_price.
    pub price_feed: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct InitializeOracleUnpriced<'info> {
    #[account(
        init,
        payer = authority,
        space = OraclePrice::SPACE,
        seeds = [b"oracle", feed_id.as_ref()],
        bump,
    )]
    pub oracle: Account<'info, OraclePrice>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    #[account(
        mut,
        seeds = [b"oracle", PYTH_SOL_USD_FEED_ID.as_ref()],
        bump = oracle.bump,
    )]
    pub oracle: Account<'info, OraclePrice>,
    /// CHECK: exact sponsored Pyth push-feed PDA; owner, verification level, feed id, and freshness are validated by read_pyth_price.
    pub price_feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeMatchResult<'info> {
    #[account(mut, has_one = authority)]
    pub match_state: Account<'info, MatchV2>,
    #[account(
        init,
        payer = authority,
        space = MatchResult::SPACE,
        seeds = [b"result", match_state.key().as_ref()],
        bump,
    )]
    pub result: Account<'info, MatchResult>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeEscrow<'info> {
    #[account(mut, has_one = authority)]
    pub match_state: Account<'info, MatchV2>,
    #[account(
        init,
        payer = authority,
        space = Escrow::SPACE,
        seeds = [ESCROW_SEED, match_state.key().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializePrivateQuote<'info> {
    #[account(
        init,
        payer = authority,
        space = PrivateQuote::SPACE,
        seeds = [PRIVATE_QUOTE_SEED, match_state.key().as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    pub match_state: Account<'info, MatchV2>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializePrivateInventory<'info> {
    #[account(
        init,
        payer = authority,
        space = PrivateInventory::SPACE,
        seeds = [PRIVATE_INVENTORY_SEED, match_state.key().as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub inventory: Account<'info, PrivateInventory>,
    pub match_state: Account<'info, MatchV2>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PrivateQuotePermission<'info> {
    pub match_state: Account<'info, MatchV2>,
    /// CHECK: identity is checked by the quote and SessionGrant constraints.
    pub authority: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [
            SESSION_SEED,
            match_state.key().as_ref(),
            authority.key().as_ref(),
            session_signer.key().as_ref()
        ],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
    #[account(
        mut,
        seeds = [PRIVATE_QUOTE_SEED, match_state.key().as_ref(), authority.key().as_ref()],
        bump = quote.bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    /// CHECK: verified by MagicBlock and PDA seeds.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, quote.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock private-permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock ephemeral vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PrivateInventoryPermission<'info> {
    pub match_state: Account<'info, MatchV2>,
    /// CHECK: identity is checked by the inventory and SessionGrant constraints.
    pub authority: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [
            SESSION_SEED,
            match_state.key().as_ref(),
            authority.key().as_ref(),
            session_signer.key().as_ref()
        ],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
    #[account(
        mut,
        seeds = [
            PRIVATE_INVENTORY_SEED,
            match_state.key().as_ref(),
            authority.key().as_ref()
        ],
        bump = inventory.bump,
    )]
    pub inventory: Account<'info, PrivateInventory>,
    /// CHECK: verified by MagicBlock and PDA seeds.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, inventory.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock private-permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock ephemeral vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_key: Pubkey)]
pub struct DelegateRuntime<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the delegation macro validates this canonical runtime PDA.
    #[account(
        mut,
        del,
        seeds = [RUNTIME_SEED, match_key.as_ref()],
        bump,
    )]
    pub runtime: UncheckedAccount<'info>,
    /// CHECK: checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_key: Pubkey, dealer: Pubkey)]
pub struct DelegatePrivateQuote<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        del,
        seeds = [PRIVATE_QUOTE_SEED, match_key.as_ref(), dealer.as_ref()],
        bump,
    )]
    /// CHECK: the delegation macro validates this canonical quote PDA.
    pub quote: UncheckedAccount<'info>,
    /// CHECK: checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_key: Pubkey, player: Pubkey)]
pub struct DelegatePrivateInventory<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        del,
        seeds = [PRIVATE_INVENTORY_SEED, match_key.as_ref(), player.as_ref()],
        bump,
    )]
    /// CHECK: the delegation macro validates this canonical inventory PDA.
    pub inventory: UncheckedAccount<'info>,
    /// CHECK: checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct OpenRfq<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    #[account(
        seeds = [b"oracle", PYTH_SOL_USD_FEED_ID.as_ref()],
        bump = oracle.bump,
    )]
    pub oracle: Account<'info, OraclePrice>,
    /// CHECK: bound to the session grant and checked against MatchV2 players.
    pub authority: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [
            SESSION_SEED,
            match_state.key().as_ref(),
            authority.key().as_ref(),
            session_signer.key().as_ref()
        ],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
}

#[derive(Accounts)]
pub struct SubmitQuote<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    /// CHECK: bound to the session grant and canonical quote PDA.
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [PRIVATE_QUOTE_SEED, match_state.key().as_ref(), authority.key().as_ref()],
        bump = quote.bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [
            SESSION_SEED,
            match_state.key().as_ref(),
            authority.key().as_ref(),
            session_signer.key().as_ref()
        ],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
}

#[derive(Accounts)]
pub struct ResolveRound<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    #[account(
        mut,
        seeds = [
            PRIVATE_INVENTORY_SEED,
            match_state.key().as_ref(),
            runtime.taker.as_ref()
        ],
        bump = taker_inventory.bump,
    )]
    pub taker_inventory: Account<'info, PrivateInventory>,
}

#[derive(Accounts)]
pub struct SkipEmptyRound<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
}

#[derive(Accounts)]
pub struct AdvanceRound<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
}

#[derive(Accounts)]
pub struct FinalizeRuntime<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    #[account(
        seeds = [b"oracle", PYTH_SOL_USD_FEED_ID.as_ref()],
        bump = oracle.bump,
    )]
    pub oracle: Account<'info, OraclePrice>,
}

#[derive(Accounts)]
pub struct ScrubPrivateQuote<'info> {
    #[account(
        seeds = [RUNTIME_SEED, runtime.match_key.as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    #[account(
        mut,
        seeds = [
            PRIVATE_QUOTE_SEED,
            quote.match_key.as_ref(),
            quote.authority.as_ref()
        ],
        bump = quote.bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    /// CHECK: verified by MagicBlock and PDA seeds.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, quote.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock private-permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock ephemeral vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ScrubPrivateInventory<'info> {
    #[account(
        seeds = [RUNTIME_SEED, runtime.match_key.as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    #[account(
        mut,
        seeds = [
            PRIVATE_INVENTORY_SEED,
            inventory.match_key.as_ref(),
            inventory.authority.as_ref()
        ],
        bump = inventory.bump,
    )]
    pub inventory: Account<'info, PrivateInventory>,
    /// CHECK: verified by MagicBlock and PDA seeds.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, inventory.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock private-permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock ephemeral vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: constrained to the MagicBlock program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FinalizeMatch<'info> {
    #[account(mut)]
    pub match_state: Account<'info, MatchV2>,
    #[account(
        seeds = [RUNTIME_SEED, match_state.key().as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    #[account(
        mut,
        seeds = [b"result", match_state.key().as_ref()],
        bump = result.bump,
    )]
    pub result: Account<'info, MatchResult>,
}

#[derive(Accounts)]
pub struct SettleMatch<'info> {
    pub match_state: Account<'info, MatchV2>,
    #[account(
        mut,
        seeds = [b"result", match_state.key().as_ref()],
        bump = result.bump,
    )]
    pub result: Account<'info, MatchResult>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, match_state.key().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: must equal the finalized result winner; it need not sign.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitRuntime<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [RUNTIME_SEED, runtime.match_key.as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitPrivateQuote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [
            PRIVATE_QUOTE_SEED,
            quote.match_key.as_ref(),
            quote.authority.as_ref()
        ],
        bump = quote.bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitPrivateInventory<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [
            PRIVATE_INVENTORY_SEED,
            inventory.match_key.as_ref(),
            inventory.authority.as_ref()
        ],
        bump = inventory.bump,
    )]
    pub inventory: Account<'info, PrivateInventory>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateRuntime<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [RUNTIME_SEED, runtime.match_key.as_ref()],
        bump = runtime.bump,
    )]
    pub runtime: Account<'info, MatchRuntime>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegatePrivateQuote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [
            PRIVATE_QUOTE_SEED,
            quote.match_key.as_ref(),
            quote.authority.as_ref()
        ],
        bump = quote.bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegatePrivateInventory<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [
            PRIVATE_INVENTORY_SEED,
            inventory.match_key.as_ref(),
            inventory.authority.as_ref()
        ],
        bump = inventory.bump,
    )]
    pub inventory: Account<'info, PrivateInventory>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[account]
pub struct PitConfig {
    pub authority: Pubkey,
    pub pit_id: [u8; 32],
    pub capacity: u8,
    pub active_match: Pubkey,
    pub bump: u8,
}

impl PitConfig {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 32 + 1;
}

#[account]
pub struct OraclePrice {
    pub authority: Pubkey,
    pub feed_id: [u8; 32],
    pub price_e6: i64,
    pub published_at: i64,
    pub bump: u8,
}

impl OraclePrice {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

#[account]
pub struct SessionGrant {
    pub match_key: Pubkey,
    pub authority: Pubkey,
    pub session_key: Pubkey,
    pub expires_at: i64,
    pub action_mask: u8,
    pub revoked: bool,
    pub bump: u8,
}

impl SessionGrant {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 1 + 1;
}

#[account]
pub struct MatchV2 {
    pub authority: Pubkey,
    pub pit: Pubkey,
    pub status: u8,
    pub capacity: u8,
    pub player_count: u8,
    pub round_count: u8,
    pub players: [Pubkey; MAX_PLAYERS],
    pub bump: u8,
}

impl MatchV2 {
    pub const SPACE: usize = 8 // discriminator
        + 32 // authority
        + 32 // pit
        + 1 // status
        + 1 // capacity
        + 1 // player_count
        + 1 // round_count
        + 32 * MAX_PLAYERS // players
        + 1; // bump

    fn join(&mut self, player: Pubkey) -> Result<()> {
        require!(self.status == MATCH_WAITING, ErrorCode::MatchNotJoinable);
        require!(self.player_count < self.capacity, ErrorCode::MatchFull);
        require!(!self.players.contains(&player), ErrorCode::DuplicatePlayer);
        self.players[self.player_count as usize] = player;
        self.player_count = self
            .player_count
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        Ok(())
    }

    fn start(&mut self, host: Pubkey, round_count: u8) -> Result<()> {
        require_keys_eq!(self.authority, host, ErrorCode::NotMatchHost);
        require!(self.players.contains(&host), ErrorCode::NotAMatchPlayer);
        require!(self.status == MATCH_WAITING, ErrorCode::MatchAlreadyStarted);
        require!(
            self.player_count >= MIN_PLAYERS_TO_START,
            ErrorCode::NotEnoughPlayers
        );
        require!(
            round_count > 0 && round_count <= MAX_ROUNDS,
            ErrorCode::InvalidRoundCount
        );
        self.round_count = round_count;
        self.status = MATCH_STARTED;
        Ok(())
    }
}

#[account]
pub struct MatchRuntime {
    pub match_key: Pubkey,
    pub round: u8,
    pub taker: Pubkey,
    pub side: u8,
    pub quantity_lots: u64,
    pub opened_at: i64,
    pub deadline: i64,
    pub quote_count: u8,
    pub status: u8,
    pub oracle: Pubkey,
    pub oracle_price_e6: i64,
    pub winning_dealer: Pubkey,
    pub clearing_price: i64,
    pub last_resolved_round: u8,
    pub last_round_winner: Pubkey,
    pub finalized_at: i64,
    pub winner: Pubkey,
    pub final_scores_e6: [i64; MAX_PLAYERS],
    pub bump: u8,
}

impl MatchRuntime {
    pub const SPACE: usize = 8 // discriminator
        + 32 // match_key
        + 1 // round
        + 32 // taker
        + 1 // side
        + 8 // quantity_lots
        + 8 // opened_at
        + 8 // deadline
        + 1 // quote_count
        + 1 // status
        + 32 // oracle
        + 8 // oracle_price_e6
        + 32 // winning_dealer
        + 8 // clearing_price
        + 1 // last_resolved_round
        + 32 // last_round_winner
        + 8 // finalized_at
        + 32 // winner
        + 8 * MAX_PLAYERS // final_scores_e6
        + 1; // bump
}

#[account]
pub struct MatchResult {
    pub match_key: Pubkey,
    pub winner: Pubkey,
    pub final_scores_e6: [i64; MAX_PLAYERS],
    pub completed_at: i64,
    pub settled: bool,
    pub bump: u8,
}

impl MatchResult {
    pub const SPACE: usize = 8 + 32 + 32 + (8 * MAX_PLAYERS) + 8 + 1 + 1;
}

#[account]
pub struct Escrow {
    pub match_key: Pubkey,
    pub payout_lamports: u64,
    pub bump: u8,
}

impl Escrow {
    pub const SPACE: usize = 8 + 32 + 8 + 1;
}

#[account]
pub struct PrivateQuote {
    pub match_key: Pubkey,
    pub round: u8,
    pub authority: Pubkey,
    pub price_e6: i64,
    pub submitted_at: i64,
    pub locked: bool,
    pub bump: u8,
}

impl PrivateQuote {
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 8 + 8 + 1 + 1;
}

#[account]
pub struct PrivateInventory {
    pub match_key: Pubkey,
    pub authority: Pubkey,
    pub sol_position_lots: i64,
    pub cash_e6: i128,
    pub realized_pnl_e6: i128,
    pub filled_notional_e6: u128,
    pub bump: u8,
}

impl PrivateInventory {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 16 + 16 + 16 + 1;
}

#[event]
pub struct RfqOpened {
    pub match_key: Pubkey,
    pub round: u8,
    pub taker: Pubkey,
    pub side: u8,
    pub quantity_lots: u64,
    pub deadline: i64,
    pub oracle_price_e6: i64,
}

#[event]
pub struct RoundResolved {
    pub match_key: Pubkey,
    pub round: u8,
    pub taker: Pubkey,
    pub side: u8,
    pub quantity_lots: u64,
    pub winning_dealer: Pubkey,
    pub clearing_price: i64,
}

#[event]
pub struct EmptyRoundSkipped {
    pub match_key: Pubkey,
    pub round: u8,
    pub deadline: i64,
}

#[event]
pub struct RuntimeFinalized {
    pub match_key: Pubkey,
    pub winner: Pubkey,
    pub final_scores_e6: [i64; MAX_PLAYERS],
}

#[event]
pub struct MatchFinalized {
    pub match_key: Pubkey,
    pub winner: Pubkey,
    pub completed_at: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("pit capacity must be between one and four players")]
    InvalidPitCapacity,
    #[msg("pit already has an active match")]
    PitHasActiveMatch,
    #[msg("match is not accepting players")]
    MatchNotJoinable,
    #[msg("match has reached its player capacity")]
    MatchFull,
    #[msg("wallet is already a member of this match")]
    DuplicatePlayer,
    #[msg("at least two players are required to trade")]
    NotEnoughPlayers,
    #[msg("match has already started")]
    MatchAlreadyStarted,
    #[msg("match must be started first")]
    MatchNotStarted,
    #[msg("wallet is not a member of this match")]
    NotAMatchPlayer,
    #[msg("private account authority does not match the requested owner")]
    PrivateAuthorityMismatch,
    #[msg("side must be BUY or SELL")]
    InvalidSide,
    #[msg("quantity is not one of the allowed lot sizes")]
    InvalidQuantity,
    #[msg("oracle price is stale or invalid")]
    OracleStale,
    #[msg("oracle snapshot is invalid")]
    OracleInvalid,
    #[msg("quote is outside the configured oracle deviation band")]
    QuoteOutsideBand,
    #[msg("quote window must be between one and thirty seconds")]
    InvalidQuoteWindow,
    #[msg("caller is not the current round taker")]
    NotCurrentTaker,
    #[msg("round is not ready to open")]
    RoundNotOpen,
    #[msg("quote deadline has passed")]
    QuoteDeadlinePassed,
    #[msg("quote account does not match the match or dealer")]
    InvalidQuoteAccount,
    #[msg("dealer cannot quote its own RFQ")]
    DealerIsTaker,
    #[msg("quote is already locked")]
    QuoteLocked,
    #[msg("quote signer does not own the quote account")]
    QuoteNotAuthorized,
    #[msg("quote count does not match the supplied quote accounts")]
    QuoteCountMismatch,
    #[msg("round has sealed quotes and cannot be skipped")]
    EmptyRoundRequired,
    #[msg("not enough valid dealer quotes")]
    NotEnoughQuotes,
    #[msg("round deadline has not been reached")]
    DeadlineNotReached,
    #[msg("round has not been resolved")]
    RoundNotResolved,
    #[msg("match has not completed all rounds")]
    MatchNotFinished,
    #[msg("match has already completed all rounds")]
    MatchFinished,
    #[msg("score has already been finalized")]
    ScoresAlreadyFinalized,
    #[msg("match result has already been settled")]
    AlreadySettled,
    #[msg("match result is not finalized")]
    ResultNotFinalized,
    #[msg("settlement account relationship is invalid")]
    SettlementMismatch,
    #[msg("settlement winner does not match the finalized result")]
    WrongWinner,
    #[msg("escrow amount must be positive")]
    InvalidEscrowAmount,
    #[msg("escrow does not contain the configured payout")]
    EscrowInsufficientFunds,
    #[msg("escrow account does not belong to the match")]
    EscrowMismatch,
    #[msg("inventory account does not match the expected player and match")]
    InventoryMismatch,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("session grant is invalid")]
    InvalidSession,
    #[msg("session grant has expired")]
    SessionExpired,
    #[msg("session grant does not permit this action")]
    SessionActionNotAllowed,
    #[msg("session duration is outside the allowed match window")]
    InvalidSessionDuration,
    #[msg("session action mask contains an unauthorized action")]
    InvalidSessionActionMask,
    #[msg("only the match authority can start the match")]
    NotMatchHost,
    #[msg("round count must be between one and eight")]
    InvalidRoundCount,
    #[msg("the supplied match is not the pit's active match")]
    ActiveMatchMismatch,
    #[msg("the active match has progressed and cannot be released")]
    MatchNotReleasable,
    #[msg("the supplied match account has an unsupported layout")]
    InvalidMatchAccount,
    #[msg("the legacy match cannot be migrated without losing active round state")]
    LegacyMigrationNotSafe,
    #[msg("runtime account is invalid")]
    InvalidRuntime,
    #[msg("runtime is not terminal")]
    RuntimeNotTerminal,
    #[msg("runtime has not finalized its public result")]
    RuntimeNotFinalized,
    #[msg("private state has not been scrubbed")]
    PrivateStateNotScrubbed,
    #[msg("private permission account is malformed or does not match its private account")]
    InvalidPrivatePermission,
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    fn legacy_account(len: usize, pit: Pubkey, authority: Pubkey, nonce: u64) -> Vec<u8> {
        let mut data = vec![0; len];
        data[..8].copy_from_slice(&LEGACY_MATCH_DISCRIMINATOR);
        data[8..40].copy_from_slice(authority.as_ref());
        data[LEGACY_MATCH_PIT_OFFSET..LEGACY_MATCH_PIT_OFFSET + 32].copy_from_slice(pit.as_ref());
        data[LEGACY_MATCH_NONCE_OFFSET..LEGACY_MATCH_NONCE_OFFSET + 8]
            .copy_from_slice(&nonce.to_le_bytes());
        data[LEGACY_MATCH_STATUS_OFFSET] = MATCH_WAITING;
        data[LEGACY_MATCH_CAPACITY_OFFSET] = MAX_PLAYERS as u8;
        data[LEGACY_MATCH_PLAYER_COUNT_OFFSET] = 1;
        if len != LEGACY_MATCH_SPACE {
            data[LEGACY_MATCH_CURRENT_ROUND_OFFSET] = 0;
        }
        if len == LEGACY_CURRENT_MATCH_SPACE {
            data[LEGACY_MATCH_ROUND_COUNT_OFFSET] = 5;
        }
        data
    }

    #[test]
    fn legacy_layouts_parse_without_using_seat_bytes() {
        let pit = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let player = Pubkey::new_unique();
        for len in [
            LEGACY_MATCH_SPACE,
            PREVIOUS_MATCH_SPACE,
            LEGACY_CURRENT_MATCH_SPACE,
        ] {
            let mut data = legacy_account(len, pit, authority, 7);
            let player_offset = if len == LEGACY_MATCH_SPACE {
                LEGACY_MATCH_PLAYERS_OFFSET
            } else {
                PREVIOUS_MATCH_PLAYERS_OFFSET
            };
            data[player_offset..player_offset + 32].copy_from_slice(player.as_ref());
            let snapshot = parse_legacy_match(&data).unwrap();
            assert_eq!(snapshot.pit, pit);
            assert_eq!(snapshot.authority, authority);
            assert_eq!(snapshot.match_nonce, 7);
            assert_eq!(snapshot.players[0], player);
            assert_eq!(snapshot.current_round, 0);
            assert_eq!(
                snapshot.round_count,
                if len == LEGACY_CURRENT_MATCH_SPACE {
                    5
                } else {
                    DEFAULT_ROUND_COUNT
                }
            );
        }
    }

    #[test]
    fn release_validation_accepts_v2_and_legacy_pdas_only() {
        let pit = Pubkey::new_unique();
        let legacy_nonce = 11_u64;
        let (legacy_key, _) = Pubkey::find_program_address(
            &[LEGACY_MATCH_SEED, pit.as_ref(), &legacy_nonce.to_le_bytes()],
            &crate::ID,
        );
        let legacy = legacy_account(
            LEGACY_CURRENT_MATCH_SPACE,
            pit,
            Pubkey::new_unique(),
            legacy_nonce,
        );
        validate_legacy_match_for_release(&legacy, pit, legacy_key, false).unwrap();

        let v2_nonce = 12_u64;
        let (v2_key, _) = Pubkey::find_program_address(
            &[MATCH_SEED, pit.as_ref(), &v2_nonce.to_le_bytes()],
            &crate::ID,
        );
        let mut v2 = vec![0; MatchV2::SPACE];
        v2[..8].copy_from_slice(MatchV2::DISCRIMINATOR);
        v2[40..72].copy_from_slice(pit.as_ref());
        v2[72] = MATCH_WAITING;
        v2[74] = 0;
        validate_v2_match_for_release(&v2, pit, v2_key, v2_nonce, false).unwrap();
        assert!(validate_v2_match_for_release(&v2, pit, v2_key, v2_nonce + 1, false).is_err());
    }

    #[test]
    fn sol_usd_push_feed_is_the_canonical_shard_zero_account() {
        let shard_zero = [0_u8; 2];
        let (feed, _) = Pubkey::find_program_address(
            &[&shard_zero, PYTH_SOL_USD_FEED_ID.as_ref()],
            &PYTH_PUSH_ORACLE_PROGRAM_ID,
        );
        assert_eq!(feed, PYTH_SOL_USD_PUSH_FEED);
    }
}

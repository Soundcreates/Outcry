use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi},
        structs::{EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG},
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
pub const NO_RESOLVED_ROUND: u8 = u8::MAX;
pub const MIN_PLAYERS_TO_START: u8 = 2;
pub const MATCH_WAITING: u8 = 0;
pub const MATCH_STARTED: u8 = 1;
pub const MATCH_FINISHED: u8 = 2;
pub const ROUND_PREPARED: u8 = 2;
pub const ROUND_OPEN: u8 = 0;
pub const ROUND_RESOLVED: u8 = 1;
pub const ROUND_SKIPPED: u8 = 3;
pub const SIDE_BUY: u8 = game::BUY;
pub const SIDE_SELL: u8 = game::SELL;
pub const ORACLE_MAX_AGE_SECONDS: i64 = game::DEFAULT_ORACLE_MAX_AGE_SECONDS;
pub const MAX_DEVIATION_BPS: u64 = game::DEFAULT_MAX_DEVIATION_BPS;
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey =
    pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
pub const PYTH_SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4,
    0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc,
    0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];
pub const SESSION_SEED: &[u8] = b"session";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const SESSION_MAX_DURATION_SECONDS: i64 = 15 * 60;
pub const SESSION_ACTION_MASK: u8 = (game::SessionAction::OpenRfq as u8)
    | (game::SessionAction::SubmitQuote as u8)
    | (game::SessionAction::ResolveRound as u8)
    | (game::SessionAction::NextRound as u8);

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
        require!(capacity > 0 && capacity as usize <= MAX_PLAYERS, ErrorCode::InvalidPitCapacity);

        let pit = &mut ctx.accounts.pit;
        pit.authority = ctx.accounts.authority.key();
        pit.pit_id = pit_id;
        pit.capacity = capacity;
        pit.active_match = Pubkey::default();
        pit.bump = ctx.bumps.pit;
        Ok(())
    }

    pub fn create_match(ctx: Context<CreateMatch>, match_nonce: u64) -> Result<()> {
        let pit = &mut ctx.accounts.pit;
        require!(pit.active_match == Pubkey::default(), ErrorCode::PitHasActiveMatch);

        let match_state = &mut ctx.accounts.match_state;
        match_state.authority = ctx.accounts.authority.key();
        match_state.pit = pit.key();
        match_state.match_nonce = match_nonce;
        match_state.status = MATCH_WAITING;
        match_state.capacity = pit.capacity;
        match_state.player_count = 0;
        match_state.current_round = 0;
        match_state.players = [Pubkey::default(); MAX_PLAYERS];
        match_state.seats = [Pubkey::default(); MAX_PLAYERS];
        match_state.result = Pubkey::default();
        match_state.bump = ctx.bumps.match_state;
        match_state.round_count = DEFAULT_ROUND_COUNT;
        match_state.last_resolved_round = NO_RESOLVED_ROUND;
        match_state.last_round_winner = Pubkey::default();
        pit.active_match = match_state.key();
        Ok(())
    }

    pub fn release_active_match(ctx: Context<ReleaseActiveMatch>, force: bool) -> Result<()> {
        let pit = &mut ctx.accounts.pit;
        let match_info = ctx.accounts.match_state.to_account_info();
        require_keys_eq!(pit.active_match, match_info.key(), ErrorCode::ActiveMatchMismatch);
        require!(
            *match_info.owner == crate::ID || *match_info.owner == DELEGATION_PROGRAM_ID,
            ErrorCode::InvalidMatchAccount
        );

        // Cleanup is controlled by the pit authority above. A legacy/delegated match can
        // retain a different match authority, so it must not reuse the start-match host check.
        let (stored_pit, match_nonce, status, current_round, result) = {
            let data = match_info.try_borrow_data()?;
            require!(
                data.len() == LEGACY_MATCH_SPACE
                    || data.len() == PREVIOUS_MATCH_SPACE
                    || data.len() == Match::SPACE,
                ErrorCode::InvalidMatchAccount
            );
            require!(&data[..8] == Match::DISCRIMINATOR, ErrorCode::InvalidMatchAccount);

            let stored_pit = Pubkey::new_from_array(
                data[40..72]
                    .try_into()
                    .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
            );
            let match_nonce = u64::from_le_bytes(
                data[72..80]
                    .try_into()
                    .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
            );
            let current_round = if data.len() == LEGACY_MATCH_SPACE { 0 } else { data[83] };
            let result_offset = if data.len() == LEGACY_MATCH_SPACE { 339 } else { 340 };
            let result = Pubkey::new_from_array(
                data[result_offset..result_offset + 32]
                    .try_into()
                    .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
            );
            (stored_pit, match_nonce, data[80], current_round, result)
        };

        require_keys_eq!(stored_pit, pit.key(), ErrorCode::InvalidMatchAccount);
        let (expected_match, _) = Pubkey::find_program_address(
            &[b"match", pit.key().as_ref(), &match_nonce.to_le_bytes()],
            &crate::ID,
        );
        require_keys_eq!(expected_match, match_info.key(), ErrorCode::InvalidMatchAccount);
        if !force {
            require!(
                match_can_be_released(status, current_round, result),
                ErrorCode::MatchNotReleasable
            );
        }

        pit.active_match = Pubkey::default();
        Ok(())
    }

    pub fn join_match(ctx: Context<JoinMatch>, seat_index: u8) -> Result<()> {
        ctx.accounts
            .match_state
            .join(ctx.accounts.player.key(), seat_index)
    }

    pub fn start_match(ctx: Context<StartMatch>, round_count: u8) -> Result<()> {
        ctx.accounts.match_state.start(ctx.accounts.authority.key(), round_count)
    }

    pub fn prepare_rfq_round(ctx: Context<PrepareRfqRound>) -> Result<()> {
        let match_state = &ctx.accounts.match_state;
        require!(match_state.status == MATCH_STARTED, ErrorCode::MatchNotStarted);
        require!(match_state.player_count > 0, ErrorCode::NotEnoughPlayers);

        let round = &mut ctx.accounts.round;
        round.match_key = match_state.key();
        round.round = match_state.current_round;
        round.taker = match_state.players[match_state.current_round as usize % match_state.player_count as usize];
        round.side = SIDE_BUY;
        round.quantity_lots = 0;
        round.opened_at = 0;
        round.deadline = 0;
        round.quote_count = 0;
        round.status = ROUND_PREPARED;
        round.oracle = Pubkey::default();
        round.oracle_price_e6 = 0;
        round.winning_dealer = Pubkey::default();
        round.clearing_price = 0;
        round.bump = ctx.bumps.round;
        Ok(())
    }

    pub fn migrate_legacy_match(ctx: Context<MigrateLegacyMatch>) -> Result<()> {
        let match_info = ctx.accounts.match_state.to_account_info();
        require_keys_eq!(*match_info.owner, crate::ID, ErrorCode::InvalidMatchAccount);

        let legacy_data = match_info.try_borrow_data()?.to_vec();
        require!(
            legacy_data.len() == LEGACY_MATCH_SPACE || legacy_data.len() == PREVIOUS_MATCH_SPACE,
            ErrorCode::InvalidMatchAccount
        );
        require!(
            &legacy_data[..8] == Match::DISCRIMINATOR,
            ErrorCode::InvalidMatchAccount
        );

        let stored_authority = Pubkey::new_from_array(
            legacy_data[8..40]
                .try_into()
                .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
        );
        let first_player_offset = if legacy_data.len() == LEGACY_MATCH_SPACE { 83 } else { 84 };
        let first_player = Pubkey::new_from_array(
            legacy_data[first_player_offset..first_player_offset + 32]
                .try_into()
                .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
        );
        let host = legacy_host_for_migration(
            stored_authority,
            first_player,
            ctx.accounts.authority.key(),
        )?;

        let pit = Pubkey::new_from_array(
            legacy_data[40..72]
                .try_into()
                .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
        );
        let match_nonce = u64::from_le_bytes(
            legacy_data[72..80]
                .try_into()
                .map_err(|_| error!(ErrorCode::InvalidMatchAccount))?,
        );
        let (expected_match, _) = Pubkey::find_program_address(
            &[b"match", pit.as_ref(), &match_nonce.to_le_bytes()],
            &crate::ID,
        );
        require_keys_eq!(expected_match, match_info.key(), ErrorCode::InvalidMatchAccount);

        let required_lamports = Rent::get()?.minimum_balance(Match::SPACE);
        let current_lamports = match_info.lamports();
        if current_lamports < required_lamports {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: match_info.clone(),
                    },
                ),
                required_lamports.saturating_sub(current_lamports),
            )?;
        }

        let requires_current_round_offset = legacy_data.len() == LEGACY_MATCH_SPACE;
        match_info.resize(Match::SPACE)?;
        let mut data = match_info.try_borrow_mut_data()?;
        if requires_current_round_offset {
            for index in (83..legacy_data.len()).rev() {
                data[index + 1] = legacy_data[index];
            }
            data[83] = 0;
        }
        data[8..40].copy_from_slice(host.as_ref());
        data[373] = MAX_ROUNDS;
        data[374] = NO_RESOLVED_ROUND;
        data[375..407].fill(0);
        Ok(())
    }

    pub fn authorize_session(
        ctx: Context<AuthorizeSession>,
        session_key: Pubkey,
        expires_in_seconds: i64,
        action_mask: u8,
    ) -> Result<()> {
        require!(ctx.accounts.match_state.status == MATCH_STARTED, ErrorCode::MatchNotStarted);
        require!(ctx.accounts.match_state.players.contains(&ctx.accounts.authority.key()), ErrorCode::NotAMatchPlayer);
        require!(session_key != Pubkey::default(), ErrorCode::InvalidSession);
        require!(expires_in_seconds > 0 && expires_in_seconds <= SESSION_MAX_DURATION_SECONDS, ErrorCode::InvalidSessionDuration);
        require!(action_mask != 0 && action_mask & !SESSION_ACTION_MASK == 0, ErrorCode::InvalidSessionActionMask);

        let now = Clock::get()?.unix_timestamp;
        let session = &mut ctx.accounts.session_grant;
        session.match_key = ctx.accounts.match_state.key();
        session.authority = ctx.accounts.authority.key();
        session.session_key = session_key;
        session.expires_at = now.checked_add(expires_in_seconds).ok_or(ErrorCode::ArithmeticOverflow)?;
        session.action_mask = action_mask;
        session.revoked = false;
        session.bump = ctx.bumps.session_grant;
        Ok(())
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        require_keys_eq!(ctx.accounts.session_grant.match_key, ctx.accounts.match_state.key(), ErrorCode::InvalidSession);
        ctx.accounts.session_grant.revoked = true;
        Ok(())
    }

    pub fn initialize_oracle(
        ctx: Context<InitializeOracle>,
        feed_id: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(feed_id == PYTH_SOL_USD_FEED_ID, ErrorCode::OracleInvalid);
        let (price_e6, published_at) = read_pyth_price(&ctx.accounts.price_update, &clock)?;
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
        let (price_e6, published_at) = read_pyth_price(&ctx.accounts.price_update, &clock)?;
        require!(ctx.accounts.oracle.feed_id == PYTH_SOL_USD_FEED_ID, ErrorCode::OracleInvalid);
        ctx.accounts.oracle.price_e6 = price_e6;
        ctx.accounts.oracle.published_at = published_at;
        Ok(())
    }

    pub fn delegate_match(
        _ctx: Context<DelegateMatch>,
        _pit: Pubkey,
        _match_nonce: u64,
    ) -> Result<()> {
        err!(ErrorCode::MatchDelegationDisabled)
    }

    pub fn delegate_round(ctx: Context<DelegateRound>, match_key: Pubkey, round: u8) -> Result<()> {
        let round_state = {
            let round_data = ctx.accounts.round_state.try_borrow_data()?;
            RfqRound::try_deserialize(&mut &round_data[..])?
        };
        require_keys_eq!(round_state.match_key, match_key, ErrorCode::InvalidMatchAccount);
        require_keys_eq!(round_state.taker, ctx.accounts.authority.key(), ErrorCode::NotCurrentTaker);
        if ctx.accounts.round_state.to_account_info().owner != &ephemeral_rollups_sdk::id() {
            ctx.accounts.delegate_round_state(
                &ctx.accounts.authority,
                &[b"round", match_key.as_ref(), &[round]],
                DelegateConfig {
                    validator: ctx.accounts.validator.as_ref().map(|value| value.key()),
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }

    pub fn delegate_oracle(ctx: Context<DelegateOracle>, feed_id: [u8; 32]) -> Result<()> {
        let _ = (ctx, feed_id);
        err!(ErrorCode::OracleDelegationDisabled)
    }

    pub fn open_rfq(
        ctx: Context<OpenRfq>,
        side: u8,
        quantity_lots: u64,
        quote_window_seconds: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let match_key = ctx.accounts.match_state.key();
        let oracle_key = ctx.accounts.oracle.key();
        let round_bump = ctx.accounts.round.bump;
        open_rfq_state(
            &ctx.accounts.match_state,
            &mut ctx.accounts.round,
            &ctx.accounts.oracle,
            match_key,
            oracle_key,
            ctx.accounts.taker.key(),
            side,
            quantity_lots,
            quote_window_seconds,
            now,
            round_bump,
        )
    }

    pub fn open_rfq_session(
        ctx: Context<OpenRfqSession>,
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
        let match_key = ctx.accounts.match_state.key();
        let oracle_key = ctx.accounts.oracle.key();
        let round_bump = ctx.accounts.round.bump;
        open_rfq_state(
            &ctx.accounts.match_state,
            &mut ctx.accounts.round,
            &ctx.accounts.oracle,
            match_key,
            oracle_key,
            ctx.accounts.authority.key(),
            side,
            quantity_lots,
            quote_window_seconds,
            now,
            round_bump,
        )
    }

    pub fn commit_rfq_state(ctx: Context<CommitRfqState>) -> Result<()> {
        let _ = ctx;
        err!(ErrorCode::RfqStateCommitDisabled)
    }

    pub fn submit_quote(ctx: Context<SubmitQuote>, price_e6: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        submit_quote_state(
            &ctx.accounts.match_state,
            &mut ctx.accounts.round,
            &mut ctx.accounts.quote,
            ctx.accounts.dealer.key(),
            price_e6,
            now,
        )
    }

    pub fn submit_quote_session(ctx: Context<SubmitQuoteSession>, price_e6: i64) -> Result<()> {
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
            &mut ctx.accounts.round,
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
            &mut ctx.accounts.round,
            &mut ctx.accounts.taker_inventory,
            taker_inventory_key,
            ctx.remaining_accounts,
            now,
        )
    }

    pub fn resolve_round_session(ctx: Context<ResolveRoundSession>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.match_state.players.contains(&ctx.accounts.authority.key()), ErrorCode::NotAMatchPlayer);
        validate_session_grant(
            &ctx.accounts.session_grant,
            ctx.accounts.match_state.key(),
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
            now,
            game::SessionAction::ResolveRound,
        )?;
        let taker_inventory_key = ctx.accounts.taker_inventory.key();
        resolve_round_state(
            &ctx.accounts.match_state,
            &mut ctx.accounts.round,
            &mut ctx.accounts.taker_inventory,
            taker_inventory_key,
            ctx.remaining_accounts,
            now,
        )
    }

    pub fn skip_empty_round(ctx: Context<SkipEmptyRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        skip_empty_round_state(&ctx.accounts.match_state, &mut ctx.accounts.round, now)
    }

    pub fn next_round(ctx: Context<NextRound>) -> Result<()> {
        next_round_state(&mut ctx.accounts.match_state, &ctx.accounts.round)
    }

    pub fn next_round_session(ctx: Context<NextRoundSession>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.match_state.authority, ErrorCode::InvalidSession);
        validate_session_grant(
            &ctx.accounts.session_grant,
            ctx.accounts.match_state.key(),
            ctx.accounts.authority.key(),
            ctx.accounts.session_signer.key(),
            now,
            game::SessionAction::NextRound,
        )?;
        next_round_state(&mut ctx.accounts.match_state, &ctx.accounts.round)
    }

    pub fn finalize_scores(ctx: Context<FinalizeScores>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.match_state.status == MATCH_FINISHED, ErrorCode::MatchNotFinished);
        require!(ctx.accounts.result.completed_at == 0, ErrorCode::ScoresAlreadyFinalized);
        map_game_result(game::validate_oracle(
            ctx.accounts.oracle.price_e6,
            ctx.accounts.oracle.published_at,
            now,
            ORACLE_MAX_AGE_SECONDS,
        ))?;

        let mut winner = Pubkey::default();
        let mut winner_score = i128::MIN;
        let mut seen = [false; MAX_PLAYERS];
        for account_info in ctx.remaining_accounts.iter() {
            let inventory = Account::<PrivateInventory>::try_from(account_info).map_err(|_| error!(ErrorCode::InventoryMismatch))?;
            require_keys_eq!(inventory.match_key, ctx.accounts.match_state.key(), ErrorCode::InventoryMismatch);
            let index = ctx.accounts.match_state.players.iter().position(|player| player == &inventory.authority).ok_or(error!(ErrorCode::InventoryMismatch))?;
            require!(!seen[index], ErrorCode::InventoryMismatch);
            let (expected_inventory, _) = Pubkey::find_program_address(
                &[PRIVATE_INVENTORY_SEED, ctx.accounts.match_state.key().as_ref(), inventory.authority.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(inventory.key(), expected_inventory, ErrorCode::InventoryMismatch);
            seen[index] = true;
            let value = game::Inventory {
                sol_position_lots: inventory.sol_position_lots,
                cash_e6: inventory.cash_e6,
                realized_pnl_e6: inventory.realized_pnl_e6,
                filled_notional_e6: inventory.filled_notional_e6,
            };
            let score = map_game_result(game::score_e6(value, ctx.accounts.oracle.price_e6, 100, 100))?;
            ctx.accounts.result.final_scores_e6[index] = i64::try_from(score).map_err(|_| error!(ErrorCode::ArithmeticOverflow))?;
            if score > winner_score || (score == winner_score && inventory.authority.to_bytes() < winner.to_bytes()) {
                winner = inventory.authority;
                winner_score = score;
            }
        }
        require!(seen[..ctx.accounts.match_state.player_count as usize].iter().all(|value| *value), ErrorCode::InventoryMismatch);
        ctx.accounts.result.winner = winner;
        ctx.accounts.result.completed_at = now;
        Ok(())
    }

    pub fn settle_match(ctx: Context<SettleMatch>) -> Result<()> {
        require!(ctx.accounts.match_state.status == MATCH_FINISHED, ErrorCode::MatchNotFinished);
        require_keys_eq!(ctx.accounts.result.match_key, ctx.accounts.match_state.key(), ErrorCode::SettlementMismatch);
        require_keys_eq!(ctx.accounts.escrow.match_key, ctx.accounts.match_state.key(), ErrorCode::EscrowMismatch);
        require!(ctx.accounts.result.completed_at != 0, ErrorCode::ResultNotFinalized);
        require!(!ctx.accounts.result.settled, ErrorCode::AlreadySettled);
        require_keys_eq!(ctx.accounts.winner.key(), ctx.accounts.result.winner, ErrorCode::WrongWinner);

        let payout = ctx.accounts.escrow.payout_lamports;
        let escrow_lamports = ctx.accounts.escrow.to_account_info().lamports();
        require!(escrow_lamports >= payout, ErrorCode::EscrowInsufficientFunds);
        let remaining = escrow_lamports.checked_sub(payout).ok_or(ErrorCode::ArithmeticOverflow)?;
        let winner_lamports = ctx.accounts.winner.to_account_info().lamports();
        let winner_balance = winner_lamports.checked_add(payout).ok_or(ErrorCode::ArithmeticOverflow)?;
        **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? = remaining;
        **ctx.accounts.winner.to_account_info().try_borrow_mut_lamports()? = winner_balance;
        ctx.accounts.result.settled = true;
        Ok(())
    }

    pub fn initialize_match_result(ctx: Context<InitializeMatchResult>) -> Result<()> {
        let match_state = &mut ctx.accounts.match_state;
        require!(match_state.status == MATCH_STARTED, ErrorCode::MatchNotStarted);
        require!(match_state.result == Pubkey::default(), ErrorCode::ResultAlreadyCreated);

        let result = &mut ctx.accounts.result;
        result.match_key = match_state.key();
        result.winner = Pubkey::default();
        result.final_scores_e6 = [0; MAX_PLAYERS];
        result.completed_at = 0;
        result.settled = false;
        result.bump = ctx.bumps.result;
        match_state.result = result.key();
        Ok(())
    }

    pub fn initialize_escrow(ctx: Context<InitializeEscrow>, payout_lamports: u64) -> Result<()> {
        require!(ctx.accounts.match_state.status == MATCH_STARTED, ErrorCode::MatchNotStarted);
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

    pub fn initialize_private_quote(ctx: Context<InitializePrivateQuote>, round: u8) -> Result<()> {
        require!(ctx.accounts.match_state.players.contains(&ctx.accounts.authority.key()), ErrorCode::NotAMatchPlayer);
        prefund_ephemeral_permission(
            ctx.accounts.system_program.key(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.quote.to_account_info(),
        )?;

        let quote = &mut ctx.accounts.quote;
        quote.match_key = ctx.accounts.match_state.key();
        quote.round = round;
        quote.authority = ctx.accounts.authority.key();
        quote.price_e6 = 0;
        quote.submitted_at = 0;
        quote.locked = false;
        quote.bump = ctx.bumps.quote;
        Ok(())
    }

    pub fn initialize_private_inventory(ctx: Context<InitializePrivateInventory>) -> Result<()> {
        let match_info = ctx.accounts.match_state.to_account_info();
        require!(
            *match_info.owner == crate::ID || *match_info.owner == DELEGATION_PROGRAM_ID,
            ErrorCode::InvalidMatchAccount
        );
        let match_state = {
            let match_data = match_info.try_borrow_data()?;
            Match::try_deserialize(&mut &match_data[..])?
        };
        require!(match_state.players.contains(&ctx.accounts.authority.key()), ErrorCode::NotAMatchPlayer);
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

    pub fn delegate_private_quote(
        ctx: Context<DelegatePrivateQuote>,
        match_key: Pubkey,
        round: u8,
        dealer: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.authority.key(), dealer, ErrorCode::PrivateAuthorityMismatch);
        if ctx.accounts.quote.owner != &ephemeral_rollups_sdk::id() {
            ctx.accounts.delegate_quote(
                &ctx.accounts.authority,
                &[PRIVATE_QUOTE_SEED, match_key.as_ref(), &[round], dealer.as_ref()],
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
        require_keys_eq!(ctx.accounts.authority.key(), player, ErrorCode::PrivateAuthorityMismatch);
        if ctx.accounts.inventory.owner != &ephemeral_rollups_sdk::id() {
            ctx.accounts.delegate_inventory(
                &ctx.accounts.authority,
                &[PRIVATE_INVENTORY_SEED, match_key.as_ref(), player.as_ref()],
                DelegateConfig {
                    validator: ctx.accounts.validator.as_ref().map(|value| value.key()),
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }

    pub fn init_private_quote_permission(ctx: Context<PrivateQuotePermission>) -> Result<()> {
        if ctx.accounts.permission.lamports() > 0 {
            return Ok(());
        }
        let signers = [PRIVATE_QUOTE_SEED, ctx.accounts.quote.match_key.as_ref(), &[ctx.accounts.quote.round], ctx.accounts.quote.authority.as_ref(), &[ctx.bumps.quote]];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.quote.to_account_info(),
            permissioned_account: ctx.accounts.quote.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: private_members(ctx.accounts.quote.authority),
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    pub fn init_private_inventory_permission(ctx: Context<PrivateInventoryPermission>) -> Result<()> {
        if ctx.accounts.permission.lamports() > 0 {
            return Ok(());
        }
        let signers = [PRIVATE_INVENTORY_SEED, ctx.accounts.inventory.match_key.as_ref(), ctx.accounts.inventory.authority.as_ref(), &[ctx.bumps.inventory]];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.inventory.to_account_info(),
            permissioned_account: ctx.accounts.inventory.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: private_members(ctx.accounts.inventory.authority),
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    pub fn set_private_quote_privacy(ctx: Context<PrivateQuotePermission>, is_private: bool) -> Result<()> {
        let signers = [PRIVATE_QUOTE_SEED, ctx.accounts.quote.match_key.as_ref(), &[ctx.accounts.quote.round], ctx.accounts.quote.authority.as_ref(), &[ctx.bumps.quote]];
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.quote.to_account_info(),
            permissioned_account: ctx.accounts.quote.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.quote.to_account_info(),
            authority_is_signer: false,
            args: private_members_with_privacy(ctx.accounts.quote.authority, is_private),
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    pub fn set_private_inventory_privacy(ctx: Context<PrivateInventoryPermission>, is_private: bool) -> Result<()> {
        let signers = [PRIVATE_INVENTORY_SEED, ctx.accounts.inventory.match_key.as_ref(), ctx.accounts.inventory.authority.as_ref(), &[ctx.bumps.inventory]];
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.inventory.to_account_info(),
            permissioned_account: ctx.accounts.inventory.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.inventory.to_account_info(),
            authority_is_signer: false,
            args: private_members_with_privacy(ctx.accounts.inventory.authority, is_private),
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    pub fn close_private_quote_permission(ctx: Context<PrivateQuotePermission>) -> Result<()> {
        let signers = [PRIVATE_QUOTE_SEED, ctx.accounts.quote.match_key.as_ref(), &[ctx.accounts.quote.round], ctx.accounts.quote.authority.as_ref(), &[ctx.bumps.quote]];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.quote.to_account_info(),
            permissioned_account: ctx.accounts.quote.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.quote.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    pub fn close_private_inventory_permission(ctx: Context<PrivateInventoryPermission>) -> Result<()> {
        let signers = [PRIVATE_INVENTORY_SEED, ctx.accounts.inventory.match_key.as_ref(), ctx.accounts.inventory.authority.as_ref(), &[ctx.bumps.inventory]];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.inventory.to_account_info(),
            permissioned_account: ctx.accounts.inventory.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.inventory.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&signers])?;
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

    pub fn undelegate_private_quote(ctx: Context<UndelegatePrivateQuote>) -> Result<()> {
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

    pub fn undelegate_match(ctx: Context<UndelegateMatch>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[ctx.accounts.match_state.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn undelegate_oracle(ctx: Context<UndelegateOracle>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[ctx.accounts.oracle.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn undelegate_round(ctx: Context<UndelegateRound>) -> Result<()> {
        require!(
            ctx.accounts.round.status == ROUND_RESOLVED || ctx.accounts.round.status == ROUND_SKIPPED,
            ErrorCode::RoundNotResolved
        );
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[ctx.accounts.round.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

pub const PRIVATE_QUOTE_SEED: &[u8] = b"quote";
pub const PRIVATE_INVENTORY_SEED: &[u8] = b"inventory";

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
    require!(price_update.verification_level == VerificationLevel::Full, ErrorCode::OracleInvalid);
    let price = price_update
        .get_price_unchecked(&PYTH_SOL_USD_FEED_ID)
        .map_err(|_: GetPriceError| error!(ErrorCode::OracleInvalid))?;
    require!(price.publish_time <= clock.unix_timestamp, ErrorCode::OracleInvalid);
    require!(
        clock.unix_timestamp - price.publish_time <= ORACLE_MAX_AGE_SECONDS,
        ErrorCode::OracleStale
    );
    Ok((magicblock_price_e6(price)?, price.publish_time))
}

fn magicblock_price_e6(price: Price) -> Result<i64> {
    require!((-18..=18).contains(&price.exponent), ErrorCode::OracleInvalid);
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
    require!(value > 0 && value <= i128::from(i64::MAX), ErrorCode::OracleInvalid);
    i64::try_from(value).map_err(|_| error!(ErrorCode::ArithmeticOverflow))
}

fn pow10(exponent: u32) -> Result<i128> {
    (0..exponent).try_fold(1_i128, |value, _| {
        value.checked_mul(10).ok_or(error!(ErrorCode::ArithmeticOverflow))
    })
}

fn open_rfq_state(
    match_state: &Match,
    round: &mut RfqRound,
    oracle: &OraclePrice,
    match_key: Pubkey,
    oracle_key: Pubkey,
    taker: Pubkey,
    side: u8,
    quantity_lots: u64,
    quote_window_seconds: i64,
    now: i64,
    round_bump: u8,
) -> Result<()> {
    require!(match_state.status == MATCH_STARTED, ErrorCode::MatchNotStarted);
    require!(match_state.round_count > 0 && match_state.round_count <= MAX_ROUNDS, ErrorCode::InvalidRoundCount);
    require!(match_state.current_round < match_state.round_count, ErrorCode::MatchFinished);
    require!(
        round.status == ROUND_PREPARED || (round.status == ROUND_OPEN && round.quantity_lots == 0),
        ErrorCode::RoundNotOpen
    );
    require!(quote_window_seconds > 0 && quote_window_seconds <= 30, ErrorCode::InvalidQuoteWindow);
    map_game_result(game::validate_side(side))?;
    map_game_result(game::validate_quantity(quantity_lots))?;
    map_game_result(game::validate_oracle(
        oracle.price_e6,
        oracle.published_at,
        now,
        ORACLE_MAX_AGE_SECONDS,
    ))?;

    let taker_index = (match_state.current_round as usize) % match_state.player_count as usize;
    require_keys_eq!(taker, match_state.players[taker_index], ErrorCode::NotCurrentTaker);
    round.match_key = match_key;
    round.round = match_state.current_round;
    round.taker = taker;
    round.side = side;
    round.quantity_lots = quantity_lots;
    round.opened_at = now;
    round.deadline = now.checked_add(quote_window_seconds).ok_or(ErrorCode::ArithmeticOverflow)?;
    round.quote_count = 0;
    round.status = ROUND_OPEN;
    round.oracle = oracle_key;
    round.oracle_price_e6 = oracle.price_e6;
    round.winning_dealer = Pubkey::default();
    round.clearing_price = 0;
    round.bump = round_bump;
    Ok(())
}

fn submit_quote_state(
    match_state: &Match,
    round: &mut RfqRound,
    quote: &mut PrivateQuote,
    dealer: Pubkey,
    price_e6: i64,
    now: i64,
) -> Result<()> {
    require!(round.status == ROUND_OPEN, ErrorCode::RoundNotOpen);
    map_game_result(game::validate_quantity(round.quantity_lots))?;
    require!(now <= round.deadline, ErrorCode::QuoteDeadlinePassed);
    require!(quote.match_key == round.match_key, ErrorCode::InvalidQuoteAccount);
    require!(quote.round == round.round, ErrorCode::InvalidQuoteAccount);
    require_keys_eq!(quote.authority, dealer, ErrorCode::QuoteNotAuthorized);
    require!(dealer != round.taker, ErrorCode::DealerIsTaker);
    require!(match_state.players.contains(&dealer), ErrorCode::NotAMatchPlayer);
    require!(!quote.locked, ErrorCode::QuoteLocked);
    map_game_result(game::validate_quote(price_e6, round.oracle_price_e6, MAX_DEVIATION_BPS))?;

    quote.price_e6 = price_e6;
    quote.submitted_at = now;
    quote.locked = true;
    round.quote_count = round.quote_count.checked_add(1).ok_or(ErrorCode::ArithmeticOverflow)?;
    Ok(())
}

fn resolve_round_state<'info>(
    match_state: &Match,
    round: &mut RfqRound,
    taker_inventory: &mut PrivateInventory,
    taker_inventory_key: Pubkey,
    remaining_accounts: &'info [AccountInfo<'info>],
    now: i64,
) -> Result<()> {
    require!(round.status == ROUND_OPEN, ErrorCode::RoundNotOpen);
    map_game_result(game::validate_quantity(round.quantity_lots))?;
    require!(now >= round.deadline || round.quote_count >= match_state.player_count.saturating_sub(1), ErrorCode::DeadlineNotReached);
    require!(round.quote_count > 0, ErrorCode::NotEnoughQuotes);

    let mut candidates = Vec::with_capacity(remaining_accounts.len());
    let mut inventory_accounts = Vec::new();
    for account_info in remaining_accounts {
        let data = account_info.try_borrow_data()?;
        let discriminator = data.get(..8).ok_or(error!(ErrorCode::InvalidQuoteAccount))?;
        if discriminator == PrivateInventory::DISCRIMINATOR {
            inventory_accounts.push(account_info);
            continue;
        }
        require!(discriminator == PrivateQuote::DISCRIMINATOR, ErrorCode::InvalidQuoteAccount);
        drop(data);
        let quote = Account::<PrivateQuote>::try_from(account_info).map_err(|_| error!(ErrorCode::InvalidQuoteAccount))?;
        require!(quote.match_key == round.match_key, ErrorCode::InvalidQuoteAccount);
        require!(quote.round == round.round, ErrorCode::InvalidQuoteAccount);
        require!(quote.authority != round.taker, ErrorCode::DealerIsTaker);
        require!(match_state.players.contains(&quote.authority), ErrorCode::NotAMatchPlayer);
        let (expected_quote, _) = Pubkey::find_program_address(
            &[PRIVATE_QUOTE_SEED, round.match_key.as_ref(), &[round.round], quote.authority.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(quote.key(), expected_quote, ErrorCode::InvalidQuoteAccount);
        if !quote.locked {
            continue;
        }
        require!(!candidates.iter().any(|candidate: &game::QuoteCandidate| candidate.dealer == quote.authority), ErrorCode::InvalidQuoteAccount);
        candidates.push(game::QuoteCandidate { dealer: quote.authority, price_e6: quote.price_e6 });
    }
    require!(candidates.len() == round.quote_count as usize, ErrorCode::QuoteCountMismatch);
    let winner = map_game_result(game::select_winner(round.side, &candidates))?;

    let (expected_winner_inventory, _) = Pubkey::find_program_address(
        &[PRIVATE_INVENTORY_SEED, round.match_key.as_ref(), winner.dealer.as_ref()],
        &crate::ID,
    );
    let winning_inventory_info = inventory_accounts
        .into_iter()
        .find(|account_info| account_info.key() == expected_winner_inventory)
        .ok_or(error!(ErrorCode::InventoryMismatch))?;
    let mut winning_inventory = Account::<PrivateInventory>::try_from(winning_inventory_info)
        .map_err(|_| error!(ErrorCode::InventoryMismatch))?;

    require_keys_eq!(taker_inventory.match_key, round.match_key, ErrorCode::InventoryMismatch);
    require_keys_eq!(taker_inventory.authority, round.taker, ErrorCode::InventoryMismatch);
    require_keys_eq!(winning_inventory.match_key, round.match_key, ErrorCode::InventoryMismatch);
    require_keys_eq!(winning_inventory.authority, winner.dealer, ErrorCode::InventoryMismatch);
    require!(taker_inventory_key != winning_inventory.key(), ErrorCode::InventoryMismatch);
    let (expected_taker_inventory, _) = Pubkey::find_program_address(
        &[PRIVATE_INVENTORY_SEED, round.match_key.as_ref(), round.taker.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(taker_inventory_key, expected_taker_inventory, ErrorCode::InventoryMismatch);
    require_keys_eq!(winning_inventory.key(), expected_winner_inventory, ErrorCode::InventoryMismatch);

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
        game::Fill { side: round.side, quantity_lots: round.quantity_lots, price_e6: winner.price_e6 },
    ))?;
    taker_inventory.sol_position_lots = taker.sol_position_lots;
    taker_inventory.cash_e6 = taker.cash_e6;
    taker_inventory.realized_pnl_e6 = taker.realized_pnl_e6;
    taker_inventory.filled_notional_e6 = taker.filled_notional_e6;
    winning_inventory.sol_position_lots = dealer.sol_position_lots;
    winning_inventory.cash_e6 = dealer.cash_e6;
    winning_inventory.realized_pnl_e6 = dealer.realized_pnl_e6;
    winning_inventory.filled_notional_e6 = dealer.filled_notional_e6;
    round.status = ROUND_RESOLVED;
    round.winning_dealer = winner.dealer;
    round.clearing_price = winner.price_e6;
    Ok(())
}

fn skip_empty_round_state(match_state: &Match, round: &mut RfqRound, now: i64) -> Result<()> {
    require!(match_state.status == MATCH_STARTED, ErrorCode::MatchNotStarted);
    require!(round.status == ROUND_OPEN, ErrorCode::RoundNotOpen);
    require!(now >= round.deadline, ErrorCode::DeadlineNotReached);
    require!(round.quote_count == 0, ErrorCode::EmptyRoundRequired);
    round.status = ROUND_SKIPPED;
    emit!(EmptyRoundSkipped {
        match_key: round.match_key,
        round: round.round,
        host: match_state.authority,
        deadline: round.deadline,
    });
    Ok(())
}

fn next_round_state(match_state: &mut Match, round: &RfqRound) -> Result<()> {
    require!(
        round.status == ROUND_RESOLVED || round.status == ROUND_SKIPPED,
        ErrorCode::RoundNotResolved
    );
    require!(match_state.status == MATCH_STARTED, ErrorCode::MatchFinished);
    require!(match_state.round_count > 0 && match_state.round_count <= MAX_ROUNDS, ErrorCode::InvalidRoundCount);
    require!(round.round == match_state.current_round, ErrorCode::RoundNotResolved);
    if round.status == ROUND_RESOLVED {
        match_state.last_resolved_round = round.round;
        match_state.last_round_winner = round.winning_dealer;
    }
    if match_state.current_round + 1 >= match_state.round_count {
        match_state.status = MATCH_FINISHED;
    } else {
        match_state.current_round += 1;
    }
    Ok(())
}

fn prefund_ephemeral_permission<'info>(
    system_program: Pubkey,
    authority: AccountInfo<'info>,
    private_account: AccountInfo<'info>,
) -> Result<()> {
    transfer(
        CpiContext::new(system_program, Transfer { from: authority, to: private_account }),
        ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(1) as u32),
    )?;
    Ok(())
}

fn private_members(authority: Pubkey) -> EphemeralMembersArgs {
    private_members_with_privacy(authority, true)
}

fn private_members_with_privacy(authority: Pubkey, is_private: bool) -> EphemeralMembersArgs {
    EphemeralMembersArgs {
        is_private,
        members: if is_private {
            vec![Member { flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG, pubkey: authority }]
        } else {
            vec![]
        },
    }
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
        space = Match::SPACE,
        seeds = [b"match", pit.key().as_ref(), &match_nonce.to_le_bytes()],
        bump,
    )]
    pub match_state: Account<'info, Match>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseActiveMatch<'info> {
    #[account(mut, has_one = authority)]
    pub pit: Account<'info, PitConfig>,
    /// CHECK: handler validates ownership, discriminator, PDA, and pit authority.
    pub match_state: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(mut)]
    pub match_state: Account<'info, Match>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct StartMatch<'info> {
    #[account(mut, constraint = match_state.players[0] == authority.key() @ ErrorCode::NotMatchHost)]
    pub match_state: Account<'info, Match>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PrepareRfqRound<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        init,
        payer = taker,
        space = RfqRound::SPACE,
        seeds = [b"round", match_state.key().as_ref(), &[match_state.current_round]],
        bump,
    )]
    pub round: Account<'info, RfqRound>,
    #[account(mut)]
    pub taker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateLegacyMatch<'info> {
    /// CHECK: migration validates ownership, discriminator, PDA, and host authority before changing bytes.
    #[account(mut)]
    pub match_state: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(session_key: Pubkey, _expires_in_seconds: i64, _action_mask: u8)]
pub struct AuthorizeSession<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        init,
        payer = authority,
        space = SessionGrant::SPACE,
        seeds = [SESSION_SEED, match_state.key().as_ref(), authority.key().as_ref(), session_key.as_ref()],
        bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        has_one = authority,
        seeds = [SESSION_SEED, session_grant.match_key.as_ref(), authority.key().as_ref(), session_grant.session_key.as_ref()],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
    pub authority: Signer<'info>,
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
    /// CHECK: owner, feed identity, verification level, and freshness are checked by read_pyth_price.
    pub price_update: UncheckedAccount<'info>,
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
    #[account(mut)]
    pub oracle: Account<'info, OraclePrice>,
    /// CHECK: owner, Pyth verification level, feed identity, and freshness are checked by read_pyth_price.
    pub price_update: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct OpenRfq<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        seeds = [b"round", match_state.key().as_ref(), &[match_state.current_round]],
        bump = round.bump,
    )]
    pub round: Account<'info, RfqRound>,
    pub oracle: Account<'info, OraclePrice>,
    pub taker: Signer<'info>,
}

#[derive(Accounts)]
pub struct OpenRfqSession<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        seeds = [b"round", match_state.key().as_ref(), &[match_state.current_round]],
        bump = round.bump,
    )]
    pub round: Account<'info, RfqRound>,
    pub oracle: Account<'info, OraclePrice>,
    /// CHECK: the session grant binds this account to the authorized player.
    pub authority: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [SESSION_SEED, match_state.key().as_ref(), authority.key().as_ref(), session_signer.key().as_ref()],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitQuote<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        seeds = [b"round", match_state.key().as_ref(), &[round.round]],
        bump = round.bump,
    )]
    pub round: Account<'info, RfqRound>,
    #[account(
        mut,
        seeds = [PRIVATE_QUOTE_SEED, round.match_key.as_ref(), &[round.round], dealer.key().as_ref()],
        bump = quote.bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    pub dealer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitQuoteSession<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        seeds = [b"round", match_state.key().as_ref(), &[round.round]],
        bump = round.bump,
    )]
    pub round: Account<'info, RfqRound>,
    /// CHECK: the session grant binds this account to the authorized player.
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [PRIVATE_QUOTE_SEED, round.match_key.as_ref(), &[round.round], authority.key().as_ref()],
        bump = quote.bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [SESSION_SEED, match_state.key().as_ref(), authority.key().as_ref(), session_signer.key().as_ref()],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
}

#[derive(Accounts)]
pub struct ResolveRound<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        seeds = [b"round", match_state.key().as_ref(), &[round.round]],
        bump = round.bump,
    )]
    pub round: Account<'info, RfqRound>,
    #[account(
        mut,
        seeds = [PRIVATE_INVENTORY_SEED, round.match_key.as_ref(), round.taker.as_ref()],
        bump = taker_inventory.bump,
    )]
    pub taker_inventory: Account<'info, PrivateInventory>,
    pub resolver: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveRoundSession<'info> {
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        seeds = [b"round", match_state.key().as_ref(), &[round.round]],
        bump = round.bump,
    )]
    pub round: Account<'info, RfqRound>,
    #[account(
        mut,
        seeds = [PRIVATE_INVENTORY_SEED, round.match_key.as_ref(), round.taker.as_ref()],
        bump = taker_inventory.bump,
    )]
    pub taker_inventory: Account<'info, PrivateInventory>,
    /// CHECK: membership and the SessionGrant PDA bind this authority to the match.
    pub authority: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [SESSION_SEED, match_state.key().as_ref(), authority.key().as_ref(), session_signer.key().as_ref()],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
}

#[derive(Accounts)]
pub struct SkipEmptyRound<'info> {
    #[account(has_one = authority)]
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        seeds = [b"round", match_state.key().as_ref(), &[round.round]],
        bump = round.bump,
    )]
    pub round: Account<'info, RfqRound>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct NextRound<'info> {
    #[account(mut, has_one = authority)]
    pub match_state: Account<'info, Match>,
    #[account(seeds = [b"round", match_state.key().as_ref(), &[round.round]], bump = round.bump)]
    pub round: Account<'info, RfqRound>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct NextRoundSession<'info> {
    #[account(mut)]
    pub match_state: Account<'info, Match>,
    #[account(seeds = [b"round", match_state.key().as_ref(), &[round.round]], bump = round.bump)]
    pub round: Account<'info, RfqRound>,
    /// CHECK: checked against Match.authority and the SessionGrant PDA.
    pub authority: UncheckedAccount<'info>,
    pub session_signer: Signer<'info>,
    #[account(
        seeds = [SESSION_SEED, match_state.key().as_ref(), authority.key().as_ref(), session_signer.key().as_ref()],
        bump = session_grant.bump,
    )]
    pub session_grant: Account<'info, SessionGrant>,
}

#[derive(Accounts)]
pub struct FinalizeScores<'info> {
    #[account(constraint = match_state.players[0] == authority.key() @ ErrorCode::NotMatchHost)]
    pub match_state: Account<'info, Match>,
    #[account(mut, address = match_state.result)]
    pub result: Account<'info, MatchResult>,
    pub oracle: Account<'info, OraclePrice>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleMatch<'info> {
    pub match_state: Account<'info, Match>,
    #[account(mut, address = match_state.result)]
    pub result: Account<'info, MatchResult>,
    #[account(mut, seeds = [ESCROW_SEED, match_state.key().as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub winner: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeEscrow<'info> {
    #[account(mut, has_one = authority)]
    pub match_state: Account<'info, Match>,
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
pub struct InitializeMatchResult<'info> {
    #[account(mut, constraint = match_state.players[0] == authority.key() @ ErrorCode::NotMatchHost)]
    pub match_state: Account<'info, Match>,
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
#[instruction(round: u8)]
pub struct InitializePrivateQuote<'info> {
    #[account(
        init,
        payer = authority,
        space = PrivateQuote::SPACE,
        seeds = [PRIVATE_QUOTE_SEED, match_state.key().as_ref(), &[round], authority.key().as_ref()],
        bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    pub match_state: Account<'info, Match>,
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
    /// CHECK: The handler validates the canonical Match account owner and data.
    pub match_state: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(pit: Pubkey, match_nonce: u64)]
pub struct DelegateMatch<'info> {
    pub authority: Signer<'info>,
    /// CHECK: The match PDA is constrained by its canonical seeds.
    #[account(
        mut,
        del,
        seeds = [b"match", pit.as_ref(), &match_nonce.to_le_bytes()],
        bump,
    )]
    pub match_state: UncheckedAccount<'info>,
    /// CHECK: Checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_key: Pubkey, round: u8)]
pub struct DelegateRound<'info> {
    pub authority: Signer<'info>,
    /// CHECK: The round PDA is constrained by its canonical seeds.
    #[account(
        mut,
        del,
        seeds = [b"round", match_key.as_ref(), &[round]],
        bump,
    )]
    pub round_state: UncheckedAccount<'info>,
    /// CHECK: Checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct DelegateOracle<'info> {
    pub authority: Signer<'info>,
    /// CHECK: The oracle PDA is constrained by its canonical seeds.
    #[account(
        mut,
        del,
        seeds = [b"oracle", feed_id.as_ref()],
        bump,
    )]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: Checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_key: Pubkey, round: u8, dealer: Pubkey)]
pub struct DelegatePrivateQuote<'info> {
    pub authority: Signer<'info>,
    /// CHECK: The quote PDA is constrained by its canonical seeds.
    #[account(
        mut,
        del,
        seeds = [PRIVATE_QUOTE_SEED, match_key.as_ref(), &[round], dealer.as_ref()],
        bump,
    )]
    pub quote: AccountInfo<'info>,
    /// CHECK: Checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_key: Pubkey, player: Pubkey)]
pub struct DelegatePrivateInventory<'info> {
    pub authority: Signer<'info>,
    /// CHECK: The inventory PDA is constrained by its canonical seeds.
    #[account(
        mut,
        del,
        seeds = [PRIVATE_INVENTORY_SEED, match_key.as_ref(), player.as_ref()],
        bump,
    )]
    pub inventory: AccountInfo<'info>,
    /// CHECK: Checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct PrivateQuotePermission<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PRIVATE_QUOTE_SEED, quote.match_key.as_ref(), &[quote.round], quote.authority.as_ref()],
        has_one = authority,
        bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
    /// CHECK: Verified by the MagicBlock Permission Program and canonical PDA seeds.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, quote.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed MagicBlock Permission Program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: Fixed MagicBlock ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Fixed MagicBlock program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PrivateInventoryPermission<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PRIVATE_INVENTORY_SEED, inventory.match_key.as_ref(), inventory.authority.as_ref()],
        has_one = authority,
        bump,
    )]
    pub inventory: Account<'info, PrivateInventory>,
    /// CHECK: Verified by the MagicBlock Permission Program and canonical PDA seeds.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, inventory.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Fixed MagicBlock Permission Program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: Fixed MagicBlock ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Fixed MagicBlock program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitRfqState<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub match_state: Account<'info, Match>,
    #[account(
        mut,
        seeds = [b"round", match_state.key().as_ref(), &[round.round]],
        bump = round.bump,
    )]
    pub round: Account<'info, RfqRound>,
    #[account(
        mut,
        seeds = [b"oracle", oracle.feed_id.as_ref()],
        bump = oracle.bump,
    )]
    pub oracle: Account<'info, OraclePrice>,
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
        seeds = [PRIVATE_QUOTE_SEED, quote.match_key.as_ref(), &[quote.round], quote.authority.as_ref()],
        bump,
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
        seeds = [PRIVATE_INVENTORY_SEED, inventory.match_key.as_ref(), inventory.authority.as_ref()],
        bump,
    )]
    pub inventory: Account<'info, PrivateInventory>,
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
        seeds = [PRIVATE_QUOTE_SEED, quote.match_key.as_ref(), &[quote.round], quote.authority.as_ref()],
        bump,
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
        seeds = [PRIVATE_INVENTORY_SEED, inventory.match_key.as_ref(), inventory.authority.as_ref()],
        bump,
    )]
    pub inventory: Account<'info, PrivateInventory>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub round: Account<'info, RfqRound>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub match_state: Account<'info, Match>,
    /// CHECK: MagicBlock validates the delegated payer fee-vault PDA.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    #[account(constraint = match_state.players[0] == authority.key() @ ErrorCode::NotMatchHost)]
    pub authority: Signer<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateOracle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"oracle", oracle.feed_id.as_ref()],
        bump = oracle.bump,
    )]
    pub oracle: Account<'info, OraclePrice>,
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

impl PitConfig {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 32 + 1;
}

#[account]
pub struct Match {
    pub authority: Pubkey,
    pub pit: Pubkey,
    pub match_nonce: u64,
    pub status: u8,
    pub capacity: u8,
    pub player_count: u8,
    pub current_round: u8,
    pub players: [Pubkey; MAX_PLAYERS],
    pub seats: [Pubkey; MAX_PLAYERS],
    pub result: Pubkey,
    pub bump: u8,
    pub round_count: u8,
    pub last_resolved_round: u8,
    pub last_round_winner: Pubkey,
}

impl Match {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1 + 1 + 1 + 1 + (32 * MAX_PLAYERS) + (32 * MAX_PLAYERS) + 32 + 1 + 1 + 1 + 32;

    fn join(&mut self, player: Pubkey, seat_index: u8) -> Result<()> {
        require!(self.status == MATCH_WAITING, ErrorCode::MatchNotJoinable);
        require!(seat_index as usize <= MAX_PLAYERS - 1, ErrorCode::InvalidSeat);
        require!(self.player_count < self.capacity, ErrorCode::MatchFull);
        require!(!self.players.contains(&player), ErrorCode::DuplicatePlayer);
        require!(self.seats[seat_index as usize] == Pubkey::default(), ErrorCode::SeatOccupied);

        self.players[self.player_count as usize] = player;
        self.seats[seat_index as usize] = player;
        self.player_count += 1;
        Ok(())
    }

    fn start(&mut self, host: Pubkey, round_count: u8) -> Result<()> {
        require_keys_eq!(self.players[0], host, ErrorCode::NotMatchHost);
        require!(self.status == MATCH_WAITING, ErrorCode::MatchAlreadyStarted);
        require!(self.player_count >= MIN_PLAYERS_TO_START, ErrorCode::NotEnoughPlayers);
        require!(round_count > 0 && round_count <= MAX_ROUNDS, ErrorCode::InvalidRoundCount);
        self.round_count = round_count;
        self.status = MATCH_STARTED;
        Ok(())
    }
}

fn legacy_host_for_migration(
    stored_authority: Pubkey,
    first_player: Pubkey,
    caller: Pubkey,
) -> Result<Pubkey> {
    require!(stored_authority == caller || first_player == caller, ErrorCode::NotMatchHost);
    Ok(if first_player == Pubkey::default() { stored_authority } else { first_player })
}

fn match_can_be_released(status: u8, current_round: u8, result: Pubkey) -> bool {
    status == MATCH_FINISHED
        || ((status == MATCH_WAITING || status == MATCH_STARTED)
            && current_round == 0
            && result == Pubkey::default())
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
pub struct RfqRound {
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
    pub bump: u8,
}

impl RfqRound {
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 1 + 8 + 8 + 8 + 1 + 1 + 32 + 8 + 32 + 8 + 1;
}

#[event]
pub struct EmptyRoundSkipped {
    pub match_key: Pubkey,
    pub round: u8,
    pub host: Pubkey,
    pub deadline: i64,
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
    #[msg("seat index is outside the four-seat range")]
    InvalidSeat,
    #[msg("wallet is already a member of this match")]
    DuplicatePlayer,
    #[msg("seat is already occupied")]
    SeatOccupied,
    #[msg("at least two players are required to trade")]
    NotEnoughPlayers,
    #[msg("match has already started")]
    MatchAlreadyStarted,
    #[msg("match must be started first")]
    MatchNotStarted,
    #[msg("match result already exists")]
    ResultAlreadyCreated,
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
    #[msg("round has already been opened or resolved")]
    RoundNotOpen,
    #[msg("quote deadline has passed")]
    QuoteDeadlinePassed,
    #[msg("oracle account does not match the round")]
    OracleMismatch,
    #[msg("quote account does not match the match, round, or dealer")]
    InvalidQuoteAccount,
    #[msg("dealer cannot quote its own RFQ")]
    DealerIsTaker,
    #[msg("quote is already locked")]
    QuoteLocked,
    #[msg("quote signer does not own the quote account")]
    QuoteNotAuthorized,
    #[msg("quote is not locked")]
    QuoteNotLocked,
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
    #[msg("escrow account does not belong to the match")]
    EscrowMismatch,
    #[msg("escrow does not contain the configured payout")]
    EscrowInsufficientFunds,
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
    #[msg("only the first joined player can start the match")]
    NotMatchHost,
    #[msg("match account is invalid or uses an unsupported layout")]
    InvalidMatchAccount,
    #[msg("the supplied match is not the pit's active match")]
    ActiveMatchMismatch,
    #[msg("the active match has progressed and cannot be released")]
    MatchNotReleasable,
    #[msg("match delegation is disabled; matches must remain on the base layer")]
    MatchDelegationDisabled,
    #[msg("oracle delegation is disabled; the oracle must remain on the base layer")]
    OracleDelegationDisabled,
    #[msg("RFQ state commits are disabled; only round and private accounts are delegated")]
    RfqStateCommitDisabled,
    #[msg("round count must be between one and eight")]
    InvalidRoundCount,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_match(capacity: u8) -> Match {
        Match {
            authority: Pubkey::new_unique(),
            pit: Pubkey::new_unique(),
            match_nonce: 7,
            status: MATCH_WAITING,
            capacity,
            player_count: 0,
            current_round: 0,
            players: [Pubkey::default(); MAX_PLAYERS],
            seats: [Pubkey::default(); MAX_PLAYERS],
            result: Pubkey::default(),
            bump: 0,
            round_count: DEFAULT_ROUND_COUNT,
            last_resolved_round: NO_RESOLVED_ROUND,
            last_round_winner: Pubkey::default(),
        }
    }

    fn open_round(quote_count: u8, deadline: i64) -> RfqRound {
        RfqRound {
            match_key: Pubkey::new_unique(),
            round: 0,
            taker: Pubkey::new_unique(),
            side: SIDE_BUY,
            quantity_lots: 1,
            opened_at: deadline - 30,
            deadline,
            quote_count,
            status: ROUND_OPEN,
            oracle: Pubkey::new_unique(),
            oracle_price_e6: 100_000_000,
            winning_dealer: Pubkey::default(),
            clearing_price: 0,
            bump: 0,
        }
    }

    #[test]
    fn match_and_result_pdas_are_deterministic_and_nonce_scoped() {
        let pit = Pubkey::new_unique();
        let nonce = 7u64.to_le_bytes();
        let other_nonce = 8u64.to_le_bytes();
        let (match_a, _) = Pubkey::find_program_address(&[b"match", pit.as_ref(), nonce.as_ref()], &crate::ID);
        let (match_again, _) = Pubkey::find_program_address(&[b"match", pit.as_ref(), nonce.as_ref()], &crate::ID);
        let (match_b, _) = Pubkey::find_program_address(&[b"match", pit.as_ref(), other_nonce.as_ref()], &crate::ID);
        let (result, _) = Pubkey::find_program_address(&[b"result", match_a.as_ref()], &crate::ID);

        assert_eq!(match_a, match_again);
        assert_ne!(match_a, match_b);
        assert_ne!(result, match_a);
    }

    #[test]
    fn membership_rejects_duplicate_wallet_seat_overflow_and_invalid_seat() {
        let mut match_state = empty_match(MAX_PLAYERS as u8);
        let players = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];

        assert!(match_state.join(players[0], 0).is_ok());
        assert!(match_state.join(players[0], 1).is_err());
        assert!(match_state.join(players[1], 0).is_err());
        assert!(match_state.join(players[1], 1).is_ok());
        assert!(match_state.join(players[2], 2).is_ok());
        assert!(match_state.join(players[3], 3).is_ok());
        assert!(match_state.join(Pubkey::new_unique(), 4).is_err());
        assert!(match_state.join(Pubkey::new_unique(), 0).is_err());
        assert_eq!(match_state.player_count, 4);
    }

    #[test]
    fn only_finished_or_pre_round_matches_can_be_released() {
        assert!(match_can_be_released(MATCH_WAITING, 0, Pubkey::default()));
        assert!(match_can_be_released(MATCH_STARTED, 0, Pubkey::default()));
        assert!(match_can_be_released(MATCH_FINISHED, 7, Pubkey::new_unique()));
        assert!(!match_can_be_released(MATCH_STARTED, 1, Pubkey::default()));
        assert!(!match_can_be_released(MATCH_STARTED, 0, Pubkey::new_unique()));
    }

    #[test]
    fn start_allows_two_players_and_is_once_only() {
        let mut match_state = empty_match(MAX_PLAYERS as u8);
        let host = Pubkey::new_unique();
        assert!(match_state.join(host, 0).is_ok());
        assert!(match_state.join(Pubkey::new_unique(), 1).is_ok());
        assert!(match_state.start(Pubkey::new_unique(), DEFAULT_ROUND_COUNT).is_err());
        assert!(match_state.start(host, 0).is_err());
        assert!(match_state.start(host, MAX_ROUNDS + 1).is_err());
        assert!(match_state.start(host, DEFAULT_ROUND_COUNT).is_ok());
        assert!(match_state.start(host, DEFAULT_ROUND_COUNT).is_err());
        assert_eq!(match_state.status, MATCH_STARTED);
        assert_eq!(match_state.round_count, DEFAULT_ROUND_COUNT);
    }

    #[test]
    fn host_can_skip_only_an_empty_expired_open_round() {
        let mut match_state = empty_match(2);
        match_state.status = MATCH_STARTED;
        let mut round = open_round(0, 100);

        assert!(skip_empty_round_state(&match_state, &mut round, 99).is_err());
        assert_eq!(round.status, ROUND_OPEN);
        assert!(skip_empty_round_state(&match_state, &mut round, 100).is_ok());
        assert_eq!(round.status, ROUND_SKIPPED);

        let mut quoted_round = open_round(1, 100);
        assert!(skip_empty_round_state(&match_state, &mut quoted_round, 100).is_err());
        assert_eq!(quoted_round.status, ROUND_OPEN);
    }

    #[test]
    fn skipped_round_advances_without_a_fill() {
        let mut match_state = empty_match(2);
        match_state.status = MATCH_STARTED;
        let mut round = open_round(0, 100);
        skip_empty_round_state(&match_state, &mut round, 100).unwrap();

        next_round_state(&mut match_state, &round).unwrap();
        assert_eq!(match_state.current_round, 1);
        assert_eq!(round.winning_dealer, Pubkey::default());
        assert_eq!(round.clearing_price, 0);
    }

    #[test]
    fn legacy_migration_promotes_first_joined_player() {
        let stored_authority = Pubkey::new_unique();
        let first_player = Pubkey::new_unique();
        let second_player = Pubkey::new_unique();

        assert_eq!(
            legacy_host_for_migration(stored_authority, first_player, first_player).unwrap(),
            first_player
        );
        assert!(legacy_host_for_migration(stored_authority, first_player, second_player).is_err());
    }

    #[test]
    fn pyth_prices_convert_to_fixed_point_without_float_math() {
        let price = Price {
            price: 10_508_123_456,
            conf: 1,
            exponent: -8,
            publish_time: 0,
        };
        assert_eq!(magicblock_price_e6(price).unwrap(), 105_081_234);

        let rounded_down = Price { exponent: -7, ..price };
        assert_eq!(magicblock_price_e6(rounded_down).unwrap(), 1_050_812_345);
        assert!(magicblock_price_e6(Price { price: 1, exponent: -19, ..price }).is_err());
        assert!(magicblock_price_e6(Price { exponent: 19, ..price }).is_err());
    }
}

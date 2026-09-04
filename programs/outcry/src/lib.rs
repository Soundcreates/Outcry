use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi},
        structs::{EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG},
    },
    anchor::{commit, delegate, ephemeral},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
};

declare_id!("D2rYtfu8x3CxJ89YoAUrWbfiMGhFbAtE9Hq8RNoJaUZt");

pub const MAX_PLAYERS: usize = 4;
pub const MIN_PLAYERS_TO_START: u8 = 3;
pub const MATCH_WAITING: u8 = 0;
pub const MATCH_STARTED: u8 = 1;

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
        match_state.players = [Pubkey::default(); MAX_PLAYERS];
        match_state.seats = [Pubkey::default(); MAX_PLAYERS];
        match_state.result = Pubkey::default();
        match_state.bump = ctx.bumps.match_state;
        pit.active_match = match_state.key();
        Ok(())
    }

    pub fn join_match(ctx: Context<JoinMatch>, seat_index: u8) -> Result<()> {
        ctx.accounts
            .match_state
            .join(ctx.accounts.player.key(), seat_index)
    }

    pub fn start_match(ctx: Context<StartMatch>) -> Result<()> {
        ctx.accounts.match_state.start()
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
        require!(ctx.accounts.match_state.players.contains(&ctx.accounts.authority.key()), ErrorCode::NotAMatchPlayer);
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
        .commit_and_undelegate(&[ctx.accounts.inventory.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

pub const PRIVATE_QUOTE_SEED: &[u8] = b"quote";
pub const PRIVATE_INVENTORY_SEED: &[u8] = b"inventory";

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
pub struct JoinMatch<'info> {
    #[account(mut)]
    pub match_state: Account<'info, Match>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct StartMatch<'info> {
    #[account(mut, has_one = authority)]
    pub match_state: Account<'info, Match>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeMatchResult<'info> {
    #[account(mut, has_one = authority)]
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
    pub match_state: Account<'info, Match>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
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
    #[account(mut)]
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
    #[account(mut)]
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
pub struct CommitPrivateQuote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [PRIVATE_QUOTE_SEED, quote.match_key.as_ref(), &[quote.round], quote.authority.as_ref()],
        bump,
    )]
    pub quote: Account<'info, PrivateQuote>,
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
pub struct Match {
    pub authority: Pubkey,
    pub pit: Pubkey,
    pub match_nonce: u64,
    pub status: u8,
    pub capacity: u8,
    pub player_count: u8,
    pub players: [Pubkey; MAX_PLAYERS],
    pub seats: [Pubkey; MAX_PLAYERS],
    pub result: Pubkey,
    pub bump: u8,
}

impl Match {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1 + 1 + 1 + (32 * MAX_PLAYERS) + (32 * MAX_PLAYERS) + 32 + 1;

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

    fn start(&mut self) -> Result<()> {
        require!(self.status == MATCH_WAITING, ErrorCode::MatchAlreadyStarted);
        require!(self.player_count >= MIN_PLAYERS_TO_START, ErrorCode::NotEnoughPlayers);
        self.status = MATCH_STARTED;
        Ok(())
    }
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
    #[msg("at least three players are required to start")]
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
            players: [Pubkey::default(); MAX_PLAYERS],
            seats: [Pubkey::default(); MAX_PLAYERS],
            result: Pubkey::default(),
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
    fn start_requires_quorum_and_is_once_only() {
        let mut match_state = empty_match(MAX_PLAYERS as u8);
        assert!(match_state.join(Pubkey::new_unique(), 0).is_ok());
        assert!(match_state.join(Pubkey::new_unique(), 1).is_ok());
        assert!(match_state.start().is_err());
        assert!(match_state.join(Pubkey::new_unique(), 2).is_ok());
        assert!(match_state.start().is_ok());
        assert!(match_state.start().is_err());
        assert_eq!(match_state.status, MATCH_STARTED);
    }
}

use anchor_lang::prelude::*;

declare_id!("D2rYtfu8x3CxJ89YoAUrWbfiMGhFbAtE9Hq8RNoJaUZt");

#[program]
pub mod outcry {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

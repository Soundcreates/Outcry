use anchor_lang::prelude::Pubkey;

pub const BUY: u8 = 0;
pub const SELL: u8 = 1;
pub const ALLOWED_LOTS: [u64; 3] = [1, 2, 5];
pub const DEFAULT_MAX_DEVIATION_BPS: u64 = 500;
#[cfg(feature = "localnet")]
// The local harness snapshots one immutable oracle account before a long run.
pub const DEFAULT_ORACLE_MAX_AGE_SECONDS: i64 = 86_400;
#[cfg(not(feature = "localnet"))]
pub const DEFAULT_ORACLE_MAX_AGE_SECONDS: i64 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuoteCandidate {
    pub dealer: Pubkey,
    pub price_e6: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inventory {
    pub sol_position_lots: i64,
    pub cash_e6: i128,
    pub realized_pnl_e6: i128,
    pub filled_notional_e6: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fill {
    pub side: u8,
    pub quantity_lots: u64,
    pub price_e6: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionAction {
    OpenRfq = 1,
    SubmitQuote = 2,
    ResolveRound = 4,
    NextRound = 8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameError {
    InvalidSide,
    InvalidQuantity,
    InvalidPrice,
    OracleStale,
    OracleInvalid,
    QuoteOutsideBand,
    NoQuotes,
    ArithmeticOverflow,
    InvalidSession,
    SessionExpired,
    ActionNotAllowed,
}

pub fn validate_side(side: u8) -> Result<(), GameError> {
    if side == BUY || side == SELL {
        Ok(())
    } else {
        Err(GameError::InvalidSide)
    }
}

pub fn validate_quantity(quantity_lots: u64) -> Result<(), GameError> {
    if ALLOWED_LOTS.contains(&quantity_lots) {
        Ok(())
    } else {
        Err(GameError::InvalidQuantity)
    }
}

pub fn validate_oracle(
    price_e6: i64,
    published_at: i64,
    now: i64,
    max_age_seconds: i64,
) -> Result<(), GameError> {
    if price_e6 <= 0 || published_at > now || max_age_seconds < 0 {
        return Err(GameError::OracleInvalid);
    }
    if now.saturating_sub(published_at) > max_age_seconds {
        return Err(GameError::OracleStale);
    }
    Ok(())
}

pub fn validate_quote(
    price_e6: i64,
    oracle_price_e6: i64,
    max_deviation_bps: u64,
) -> Result<(), GameError> {
    if price_e6 <= 0 || oracle_price_e6 <= 0 {
        return Err(GameError::InvalidPrice);
    }
    let delta = (price_e6 as i128 - oracle_price_e6 as i128).unsigned_abs();
    let limit = (oracle_price_e6 as u128)
        .checked_mul(max_deviation_bps as u128)
        .ok_or(GameError::ArithmeticOverflow)?;
    if delta
        .checked_mul(10_000)
        .ok_or(GameError::ArithmeticOverflow)?
        > limit
    {
        return Err(GameError::QuoteOutsideBand);
    }
    Ok(())
}

pub fn select_winner(side: u8, quotes: &[QuoteCandidate]) -> Result<QuoteCandidate, GameError> {
    validate_side(side)?;
    let mut winner = *quotes.first().ok_or(GameError::NoQuotes)?;
    for quote in quotes.iter().skip(1) {
        let better_price = match side {
            BUY => quote.price_e6 < winner.price_e6,
            SELL => quote.price_e6 > winner.price_e6,
            _ => false,
        };
        let tie_break =
            quote.price_e6 == winner.price_e6 && quote.dealer.to_bytes() < winner.dealer.to_bytes();
        if better_price || tie_break {
            winner = *quote;
        }
    }
    Ok(winner)
}

pub fn apply_fill(
    taker: &mut Inventory,
    dealer: &mut Inventory,
    fill: Fill,
) -> Result<(), GameError> {
    validate_side(fill.side)?;
    validate_quantity(fill.quantity_lots)?;
    if fill.price_e6 <= 0 {
        return Err(GameError::InvalidPrice);
    }

    let notional = (fill.quantity_lots as u128)
        .checked_mul(fill.price_e6 as u128)
        .ok_or(GameError::ArithmeticOverflow)?;
    let notional_i128 = i128::try_from(notional).map_err(|_| GameError::ArithmeticOverflow)?;
    let quantity = i64::try_from(fill.quantity_lots).map_err(|_| GameError::ArithmeticOverflow)?;

    let (taker_position_delta, taker_cash_delta, dealer_position_delta, dealer_cash_delta) =
        if fill.side == BUY {
            (quantity, -notional_i128, -quantity, notional_i128)
        } else {
            (-quantity, notional_i128, quantity, -notional_i128)
        };

    taker.sol_position_lots = taker
        .sol_position_lots
        .checked_add(taker_position_delta)
        .ok_or(GameError::ArithmeticOverflow)?;
    taker.cash_e6 = taker
        .cash_e6
        .checked_add(taker_cash_delta)
        .ok_or(GameError::ArithmeticOverflow)?;
    dealer.sol_position_lots = dealer
        .sol_position_lots
        .checked_add(dealer_position_delta)
        .ok_or(GameError::ArithmeticOverflow)?;
    dealer.cash_e6 = dealer
        .cash_e6
        .checked_add(dealer_cash_delta)
        .ok_or(GameError::ArithmeticOverflow)?;
    taker.filled_notional_e6 = taker
        .filled_notional_e6
        .checked_add(notional)
        .ok_or(GameError::ArithmeticOverflow)?;
    dealer.filled_notional_e6 = dealer
        .filled_notional_e6
        .checked_add(notional)
        .ok_or(GameError::ArithmeticOverflow)?;
    Ok(())
}

pub fn mark_to_market(inventory: Inventory, mark_price_e6: i64) -> Result<i128, GameError> {
    if mark_price_e6 <= 0 {
        return Err(GameError::InvalidPrice);
    }
    let marked_position = (inventory.sol_position_lots as i128)
        .checked_mul(mark_price_e6 as i128)
        .ok_or(GameError::ArithmeticOverflow)?;
    inventory
        .cash_e6
        .checked_add(marked_position)
        .ok_or(GameError::ArithmeticOverflow)
}

pub fn score_e6(
    inventory: Inventory,
    mark_price_e6: i64,
    filled_weight_bps: u64,
    exposure_penalty_bps: u64,
) -> Result<i128, GameError> {
    let equity = mark_to_market(inventory, mark_price_e6)?;
    let filled_bonus = i128::try_from(inventory.filled_notional_e6)
        .map_err(|_| GameError::ArithmeticOverflow)?
        .checked_mul(filled_weight_bps as i128)
        .ok_or(GameError::ArithmeticOverflow)?
        / 10_000;
    let exposure = i128::from(inventory.sol_position_lots.unsigned_abs())
        .checked_mul(mark_price_e6 as i128)
        .ok_or(GameError::ArithmeticOverflow)?
        .checked_mul(exposure_penalty_bps as i128)
        .ok_or(GameError::ArithmeticOverflow)?
        / 10_000;
    equity
        .checked_add(filled_bonus)
        .and_then(|value| value.checked_sub(exposure))
        .ok_or(GameError::ArithmeticOverflow)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionGrant {
    pub match_key: Pubkey,
    pub authority: Pubkey,
    pub expires_at: i64,
    pub action_mask: u8,
    pub revoked: bool,
}

pub fn validate_session(
    grant: SessionGrant,
    match_key: Pubkey,
    authority: Pubkey,
    now: i64,
    action: SessionAction,
) -> Result<(), GameError> {
    if grant.revoked || grant.match_key != match_key || grant.authority != authority {
        return Err(GameError::InvalidSession);
    }
    if now >= grant.expires_at {
        return Err(GameError::SessionExpired);
    }
    if grant.action_mask & (action as u8) == 0 {
        return Err(GameError::ActionNotAllowed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inventory() -> Inventory {
        Inventory {
            sol_position_lots: 0,
            cash_e6: 0,
            realized_pnl_e6: 0,
            filled_notional_e6: 0,
        }
    }

    #[test]
    fn deterministic_buy_and_sell_winner_vectors() {
        let dealers = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        let buy = [
            QuoteCandidate {
                dealer: dealers[0],
                price_e6: 105_130_000,
            },
            QuoteCandidate {
                dealer: dealers[1],
                price_e6: 105_070_000,
            },
            QuoteCandidate {
                dealer: dealers[2],
                price_e6: 105_100_000,
            },
        ];
        assert_eq!(select_winner(BUY, &buy).unwrap().price_e6, 105_070_000);
        assert_eq!(select_winner(SELL, &buy).unwrap().price_e6, 105_130_000);
        for offset in 0..100i64 {
            let quotes = [
                QuoteCandidate {
                    dealer: dealers[0],
                    price_e6: 100_000_000 + offset,
                },
                QuoteCandidate {
                    dealer: dealers[1],
                    price_e6: 100_100_000 + offset * 2,
                },
                QuoteCandidate {
                    dealer: dealers[2],
                    price_e6: 99_900_000 + offset,
                },
            ];
            assert_eq!(
                select_winner(BUY, &quotes).unwrap().price_e6,
                quotes[2].price_e6
            );
            assert_eq!(
                select_winner(SELL, &quotes).unwrap().price_e6,
                quotes[1].price_e6
            );
        }
    }

    #[test]
    fn quote_band_and_oracle_boundaries_are_deterministic() {
        assert!(validate_oracle(105_000_000, 100, 110, 10).is_ok());
        assert_eq!(
            validate_oracle(105_000_000, 99, 110, 10),
            Err(GameError::OracleStale)
        );
        assert_eq!(
            validate_oracle(105_000_000, 111, 110, 10),
            Err(GameError::OracleInvalid)
        );
        assert!(validate_quote(110_250_000, 105_000_000, 500).is_ok());
        assert_eq!(
            validate_quote(110_250_001, 105_000_000, 500),
            Err(GameError::QuoteOutsideBand)
        );
    }

    #[test]
    fn inventory_zero_sum_invariant_holds_for_1000_fills() {
        for index in 0..1000u64 {
            let side = if index % 2 == 0 { BUY } else { SELL };
            let quantity = ALLOWED_LOTS[(index % ALLOWED_LOTS.len() as u64) as usize];
            let price = 100_000_000 + (index as i64 * 1_000);
            let mut taker = inventory();
            let mut dealer = inventory();
            apply_fill(
                &mut taker,
                &mut dealer,
                Fill {
                    side,
                    quantity_lots: quantity,
                    price_e6: price,
                },
            )
            .unwrap();
            assert_eq!(taker.sol_position_lots + dealer.sol_position_lots, 0);
            assert_eq!(taker.cash_e6 + dealer.cash_e6, 0);
            assert_eq!(taker.filled_notional_e6, dealer.filled_notional_e6);
        }
    }

    #[test]
    fn twenty_scripted_eight_round_matches_complete() {
        let players = [
            Pubkey::new_from_array([1; 32]),
            Pubkey::new_from_array([2; 32]),
            Pubkey::new_from_array([3; 32]),
            Pubkey::new_from_array([4; 32]),
        ];

        for match_index in 0..20u64 {
            let mut inventories = [inventory(); 4];
            for round_index in 0..8usize {
                let taker_index = round_index % players.len();
                let side = if (match_index + round_index as u64) % 2 == 0 {
                    BUY
                } else {
                    SELL
                };
                let quantity = ALLOWED_LOTS[(match_index as usize + round_index) % ALLOWED_LOTS.len()];
                let oracle_price = 100_000_000 + match_index as i64 * 1_000;
                let quotes: Vec<_> = players
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| *index != taker_index)
                    .map(|(dealer_index, dealer)| QuoteCandidate {
                        dealer: *dealer,
                        price_e6: oracle_price
                            + if side == BUY {
                                (dealer_index as i64 + 1) * 1_000
                            } else {
                                -((dealer_index as i64 + 1) * 1_000)
                            },
                    })
                    .collect();
                let winner = select_winner(side, &quotes).unwrap();
                let dealer_index = players.iter().position(|player| *player == winner.dealer).unwrap();
                let (taker, dealer) = if taker_index < dealer_index {
                    let (before, after) = inventories.split_at_mut(dealer_index);
                    (&mut before[taker_index], &mut after[0])
                } else {
                    let (before, after) = inventories.split_at_mut(taker_index);
                    (&mut after[0], &mut before[dealer_index])
                };

                apply_fill(
                    taker,
                    dealer,
                    Fill {
                        side,
                        quantity_lots: quantity,
                        price_e6: winner.price_e6,
                    },
                )
                .unwrap();
                assert_eq!(
                    inventories.iter().map(|value| value.sol_position_lots).sum::<i64>(),
                    0
                );
                assert_eq!(
                    inventories.iter().map(|value| value.cash_e6).sum::<i128>(),
                    0
                );
            }

            let scores: Vec<_> = inventories
                .iter()
                .map(|value| score_e6(*value, 100_000_000, 100, 100).unwrap())
                .collect();
            assert_eq!(scores.len(), 4);
            assert!(scores.iter().any(|score| *score != 0));
        }
    }

    #[test]
    fn session_scope_is_narrow_and_expires() {
        let match_key = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let grant = SessionGrant {
            match_key,
            authority,
            expires_at: 100,
            action_mask: SessionAction::SubmitQuote as u8 | SessionAction::OpenRfq as u8,
            revoked: false,
        };
        assert!(
            validate_session(grant, match_key, authority, 99, SessionAction::SubmitQuote).is_ok()
        );
        assert_eq!(
            validate_session(grant, match_key, authority, 99, SessionAction::NextRound),
            Err(GameError::ActionNotAllowed)
        );
        assert_eq!(
            validate_session(grant, match_key, authority, 100, SessionAction::SubmitQuote),
            Err(GameError::SessionExpired)
        );
    }
}

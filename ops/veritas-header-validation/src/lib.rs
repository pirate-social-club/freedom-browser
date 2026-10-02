//! Defensive MAINNET header validation prototype; not connected to navigation.
//!
//! The caller supplies an independently trusted tip and its hash-bound ancestry.
//! Trust policy, freshness, block/state validity and fork selection are separate.
use bitcoin::{block::Header, BlockHash, CompactTarget, Network, Target};

const INTERVAL: u32 = 2016;
const MAX_BATCH: usize = 2000;
const MAX_CONTEXT: usize = 2 * INTERVAL as usize + 11;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    ContextLength,
    ContextHeight,
    ContextTip,
    ContextLink(u32),
    BatchLength,
    HeightOverflow,
    ClockOverflow,
    MissingHistory(u32),
    Parent(u32),
    InvalidTarget,
    Difficulty(u32),
    TimestampMedian(u32),
    TimestampFuture(u32),
    Version(u32),
    ProofOfWork(u32),
}

/// A contiguous ancestry window bound backwards to a caller-trusted tip.
///
/// This constructor authenticates the supplied bytes against that hash. It does
/// not establish that the supplied tip is trusted: checkpoint approval or prior
/// validation must do that before this call. A server response is insufficient.
#[derive(Debug, Clone)]
pub struct BoundHistory {
    first_height: u32,
    tip_height: u32,
    headers: Vec<Header>,
}

impl BoundHistory {
    pub fn bind_trusted_tip(
        tip_height: u32,
        tip_hash: BlockHash,
        headers: Vec<Header>,
    ) -> Result<Self, ValidationError> {
        if headers.is_empty() || headers.len() > MAX_CONTEXT {
            return Err(ValidationError::ContextLength);
        }
        let length = u32::try_from(headers.len()).map_err(|_| ValidationError::ContextLength)?;
        let first_height = tip_height.checked_sub(length - 1)
            .ok_or(ValidationError::ContextHeight)?;
        if headers.last().unwrap().block_hash() != tip_hash {
            return Err(ValidationError::ContextTip);
        }
        for (offset, pair) in headers.windows(2).enumerate() {
            if pair[1].prev_blockhash != pair[0].block_hash() {
                return Err(ValidationError::ContextLink(first_height + offset as u32 + 1));
            }
        }
        if first_height == 0
            && headers[0].block_hash()
                != bitcoin::blockdata::constants::genesis_block(Network::Bitcoin).block_hash()
        {
            return Err(ValidationError::ContextTip);
        }
        Ok(Self { first_height, tip_height, headers })
    }

    fn header(&self, height: u32) -> Option<&Header> {
        let offset = height.checked_sub(self.first_height)?;
        self.headers.get(offset as usize)
    }
}

/// The whole segment passed. No partial result is returned on failure.
#[derive(Debug)]
pub struct ValidatedSegment {
    headers: Vec<Header>,
}

impl ValidatedSegment {
    pub fn into_headers(self) -> Vec<Header> { self.headers }
}

fn mainnet_target(bits: CompactTarget) -> Result<Target, ValidationError> {
    let encoded = bits.to_consensus();
    let size = encoded >> 24;
    let mut word = encoded & 0x007f_ffff;
    if size <= 3 { word >>= 8 * (3 - size); }
    let negative = word != 0 && encoded & 0x0080_0000 != 0;
    let overflow = word != 0 && (size > 34
        || (word > 0xff && size > 33) || (word > 0xffff && size > 32));
    if negative || word == 0 || overflow {
        return Err(ValidationError::InvalidTarget);
    }
    let target = Target::from_compact(bits);
    let mut limit = [0xff; 32];
    limit[..4].fill(0);
    if target == Target::ZERO || target > Target::from_be_bytes(limit) {
        return Err(ValidationError::InvalidTarget);
    }
    Ok(target)
}

fn required_bits(
    height: u32,
    parent: &Header,
    epoch_start: Option<&Header>,
) -> Result<CompactTarget, ValidationError> {
    mainnet_target(parent.bits)?;
    if height % INTERVAL != 0 { return Ok(parent.bits); }
    let first = epoch_start.ok_or(ValidationError::MissingHistory(height - INTERVAL))?;
    // Bitcoin Core uses signed subtraction, including negative epoch intervals.
    // The higher-level rust-bitcoin helper subtracts u32 timestamps directly.
    let elapsed = (i64::from(parent.time) - i64::from(first.time)).clamp(302_400, 4_838_400);
    Ok(CompactTarget::from_next_work_required(parent.bits, elapsed as u64, Network::Bitcoin))
}

fn check_version(height: u32, header: &Header) -> Result<(), ValidationError> {
    let minimum = if height >= 388_381 { 4 }
        else if height >= 363_725 { 3 }
        else if height >= 227_931 { 2 } else { i32::MIN };
    if header.version.to_consensus() < minimum {
        return Err(ValidationError::Version(height));
    }
    Ok(())
}

/// Validate an extension of the supplied branch, without changing its history.
///
/// For a fork, bind history ending at its stem first. No active-chain header
/// above that stem can participate. Apply a successful result only after the
/// caller's independently reviewed work-selection and persistence rules.
/// `now` must come from the caller's trusted clock; future-time errors may retry.
pub fn validate_mainnet_segment(
    history: &BoundHistory,
    headers: &[Header],
    now: u64,
) -> Result<ValidatedSegment, ValidationError> {
    if headers.is_empty() || headers.len() > MAX_BATCH {
        return Err(ValidationError::BatchLength);
    }
    let final_height = history.tip_height.checked_add(headers.len() as u32)
        .ok_or(ValidationError::HeightOverflow)?;
    let future_limit = now.checked_add(7200).ok_or(ValidationError::ClockOverflow)?;
    let mut staged: Vec<Header> = Vec::with_capacity(headers.len());
    for (offset, header) in headers.iter().enumerate() {
        let height = final_height - (headers.len() - offset - 1) as u32;
        let lookup = |position: u32| -> Result<&Header, ValidationError> {
            let found = if position <= history.tip_height {
                history.header(position)
            } else {
                staged.get((position - history.tip_height - 1) as usize)
            };
            found.ok_or(ValidationError::MissingHistory(position))
        };
        let parent = lookup(height - 1)?;
        if header.prev_blockhash != parent.block_hash() {
            return Err(ValidationError::Parent(height));
        }
        let epoch_start = if height % INTERVAL == 0 {
            Some(lookup(height - INTERVAL)?)
        } else { None };
        let target = mainnet_target(header.bits)?;
        if header.bits != required_bits(height, parent, epoch_start)? {
            return Err(ValidationError::Difficulty(height));
        }
        let mut timestamps = Vec::with_capacity(11);
        for previous in height.saturating_sub(11)..height {
            timestamps.push(lookup(previous)?.time);
        }
        timestamps.sort_unstable();
        if header.time <= timestamps[timestamps.len() / 2] {
            return Err(ValidationError::TimestampMedian(height));
        }
        if u64::from(header.time) > future_limit {
            return Err(ValidationError::TimestampFuture(height));
        }
        check_version(height, header)?;
        if header.validate_pow(target).is_err() {
            return Err(ValidationError::ProofOfWork(height));
        }
        staged.push(*header);
    }
    Ok(ValidatedSegment { headers: staged })
}

#[cfg(test)]
mod tests;

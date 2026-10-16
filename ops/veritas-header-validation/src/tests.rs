// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 Pirate Social Club contributors

use super::*;
use bitcoin::{block::Version, consensus::deserialize};
use std::str::FromStr;

const FIRST: u32 = 30_240;
const NOW: u64 = 1_262_200_000;

fn historical() -> Vec<Header> {
    include_str!("../fixtures/historical-context.txt").lines().enumerate().map(|(offset, line)| {
        let fields: Vec<_> = line.split_whitespace().collect();
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0].parse::<u32>().unwrap(), FIRST + offset as u32);
        let bytes: Vec<u8> = fields[2].as_bytes().chunks_exact(2).map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()
        }).collect();
        assert_eq!(bytes.len(), 80);
        let header: Header = deserialize(&bytes).unwrap();
        assert_eq!(header.block_hash(), BlockHash::from_str(fields[1]).unwrap());
        header
    }).collect()
}

fn header(height: u32) -> Header { historical()[(height - FIRST) as usize] }

fn bound(height: u32) -> BoundHistory {
    let data = historical();
    let count = (height - FIRST + 1) as usize;
    BoundHistory::bind_trusted_tip(height, data[count - 1].block_hash(), data[..count].to_vec()).unwrap()
}

fn rejected(history: &BoundHistory, batch: &[Header], now: u64, expected: ValidationError) {
    assert_eq!(validate_mainnet_segment(history, batch, now).unwrap_err(), expected);
}

#[test]
fn historical_retarget_passes_across_every_partition() {
    let data = historical();
    let batch = &data[(32_251 - FIRST) as usize..];
    let whole = validate_mainnet_segment(&bound(32_250), batch, NOW).unwrap().into_headers();
    assert_eq!(whole, batch);
    assert_eq!(header(32_255).bits.to_consensus(), 0x1d00ffff);
    assert_eq!(header(32_256).bits.to_consensus(), 0x1d00d86a);
    for split in 1..batch.len() {
        let history = bound(32_250);
        let first = validate_mainnet_segment(&history, &batch[..split], NOW).unwrap().into_headers();
        let mut ancestry = history.headers.clone();
        ancestry.extend_from_slice(&first);
        let tip = 32_250 + split as u32;
        let next = BoundHistory::bind_trusted_tip(tip, first.last().unwrap().block_hash(), ancestry).unwrap();
        let second = validate_mainnet_segment(&next, &batch[split..], NOW).unwrap().into_headers();
        assert_eq!([first, second].concat(), whole, "partition at height {tip}");
    }
}

#[test]
fn bitcoin_core_retarget_vectors() {
    // Numeric expectations from Bitcoin Core v29.0 src/test/pow_tests.cpp.
    let vectors = [
        (32_256, 1_261_130_161, 1_262_152_739, 0x1d00ffff, 0x1d00d86a),
        (2_016, 1_231_006_505, 1_233_061_996, 0x1d00ffff, 0x1d00ffff),
        (68_544, 1_279_008_237, 1_279_297_671, 0x1c05a3f4, 0x1c0168fd),
        (46_368, 1_263_163_443, 1_269_211_443, 0x1c387f6f, 0x1d00e1fd),
    ];
    for (height, first_time, last_time, bits, expected) in vectors {
        let mut parent = header(32_255);
        parent.time = last_time;
        parent.bits = CompactTarget::from_consensus(bits);
        let mut epoch = parent;
        epoch.time = first_time;
        assert_eq!(required_bits(height, &parent, Some(&epoch)).unwrap().to_consensus(), expected);
    }
}

#[test]
fn negative_epoch_interval_clamps_without_unsigned_subtraction() {
    let mut parent = header(32_255);
    parent.time = 100;
    parent.bits = CompactTarget::from_consensus(0x1c05a3f4);
    let mut epoch = parent;
    epoch.time = 200;
    assert_eq!(required_bits(68_544, &parent, Some(&epoch)).unwrap().to_consensus(), 0x1c0168fd);
}

#[test]
fn rejects_missing_epoch_context_at_the_adjustment() {
    let ancestry = historical()[(32_245 - FIRST) as usize..=(32_255 - FIRST) as usize].to_vec();
    let history = BoundHistory::bind_trusted_tip(32_255, header(32_255).block_hash(), ancestry).unwrap();
    rejected(&history, &[header(32_256)], NOW, ValidationError::MissingHistory(30_240));
}

#[test]
fn rejects_missing_median_context_away_from_genesis() {
    let history = BoundHistory::bind_trusted_tip(32_250, header(32_250).block_hash(), vec![header(32_250)]).unwrap();
    rejected(&history, &[header(32_251)], NOW, ValidationError::MissingHistory(32_240));
}

#[test]
fn rejects_context_tampering_and_wrong_branch_tip() {
    let mut history = bound(32_250).headers;
    history[500].time ^= 1;
    assert_eq!(BoundHistory::bind_trusted_tip(32_250, header(32_250).block_hash(), history).unwrap_err(),
               ValidationError::ContextLink(FIRST + 501));
    assert_eq!(BoundHistory::bind_trusted_tip(32_250, header(32_249).block_hash(), bound(32_250).headers).unwrap_err(),
               ValidationError::ContextTip);
}

#[test]
fn branch_context_cannot_include_active_chain_headers_above_the_stem() {
    assert_eq!(BoundHistory::bind_trusted_tip(32_250, header(32_250).block_hash(), historical()).unwrap_err(),
               ValidationError::ContextTip);
    rejected(&bound(32_250), &[header(32_252)], NOW, ValidationError::Parent(32_251));
}

#[test]
fn rejects_first_header_difficulty_change_between_adjustments() {
    let mut incoming = header(32_251);
    incoming.bits = header(32_256).bits;
    rejected(&bound(32_250), &[incoming], NOW, ValidationError::Difficulty(32_251));
}

#[test]
fn checks_prefix_before_an_adjustment_and_preserves_caller_state() {
    let history = bound(32_250);
    let before = history.headers.clone();
    let mut batch = historical()[(32_251 - FIRST) as usize..].to_vec();
    batch[3].bits = header(32_256).bits;
    rejected(&history, &batch, NOW, ValidationError::Difficulty(32_254));
    assert_eq!(history.headers, before);
    assert_eq!(validate_mainnet_segment(&history, &[header(32_251)], NOW).unwrap().into_headers(), vec![header(32_251)]);
}

#[test]
fn rejects_wrong_adjustment_bits_at_a_batch_boundary() {
    let mut incoming = header(32_256);
    incoming.bits = header(32_255).bits;
    rejected(&bound(32_255), &[incoming], NOW, ValidationError::Difficulty(32_256));
}

#[test]
fn rejects_wrong_bits_after_an_adjustment_inside_the_batch() {
    let mut batch = vec![header(32_256), header(32_257)];
    batch[1].bits = header(32_255).bits;
    rejected(&bound(32_255), &batch, NOW, ValidationError::Difficulty(32_257));
}

#[test]
fn compact_target_encoding_and_network_limit_checks() {
    for bits in [0, 0x01003456, 0x01800000, 0x1d80ffff, 0xff7fffff,
                 0x23000001, 0x22000100, 0x21010000, 0x1d01ffff] {
        assert_eq!(mainnet_target(CompactTarget::from_consensus(bits)), Err(ValidationError::InvalidTarget), "bits {bits:x}");
    }
    for bits in [0x01010000, 0x02000100, 0x03000001, 0x1d00ffff, 0x1c05a3f4] {
        assert!(mainnet_target(CompactTarget::from_consensus(bits)).is_ok(), "bits {bits:x}");
    }
}

#[test]
fn timestamp_must_exceed_the_median() {
    let history = bound(32_250);
    let mut times: Vec<_> = (32_240..=32_250).map(|height| header(height).time).collect();
    times.sort_unstable();
    let mut incoming = header(32_251);
    incoming.time = times[5];
    rejected(&history, &[incoming], NOW, ValidationError::TimestampMedian(32_251));
}

#[test]
fn future_time_boundary_is_inclusive_and_can_retry() {
    let history = bound(32_250);
    let incoming = header(32_251);
    let boundary = u64::from(incoming.time) - 7200;
    rejected(&history, &[incoming], boundary - 1, ValidationError::TimestampFuture(32_251));
    assert!(validate_mainnet_segment(&history, &[incoming], boundary).is_ok());
    rejected(&history, &[incoming], u64::MAX, ValidationError::ClockOverflow);
}

#[test]
fn minimum_versions_apply_at_their_mainnet_heights() {
    for (height, before_minimum, minimum) in [(227_931, 1, 2), (363_725, 2, 3), (388_381, 3, 4)] {
        let mut incoming = header(32_251);
        incoming.version = Version::from_consensus(before_minimum);
        assert!(check_version(height - 1, &incoming).is_ok());
        assert_eq!(check_version(height, &incoming), Err(ValidationError::Version(height)));
        incoming.version = Version::from_consensus(minimum);
        assert!(check_version(height, &incoming).is_ok());
    }
    let mut early = header(32_251);
    early.version = Version::from_consensus(0);
    assert!(check_version(227_930, &early).is_ok());
}

#[test]
fn proof_of_work_is_checked_after_contextual_rules() {
    let mut incoming = header(32_251);
    incoming.nonce ^= 1;
    rejected(&bound(32_250), &[incoming], NOW, ValidationError::ProofOfWork(32_251));
}

#[test]
fn limits_empty_large_and_overflowing_inputs() {
    let history = bound(32_250);
    rejected(&history, &[], NOW, ValidationError::BatchLength);
    rejected(&history, &vec![header(32_251); 2001], NOW, ValidationError::BatchLength);
    let last = BoundHistory::bind_trusted_tip(u32::MAX, header(32_250).block_hash(), vec![header(32_250)]).unwrap();
    rejected(&last, &[header(32_251)], NOW, ValidationError::HeightOverflow);
    assert_eq!(BoundHistory::bind_trusted_tip(0, header(32_250).block_hash(), vec![]).unwrap_err(), ValidationError::ContextLength);
}

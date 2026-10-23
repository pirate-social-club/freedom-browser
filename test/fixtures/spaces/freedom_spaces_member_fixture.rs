//! Deterministic member proofs for Freedom's pinned libveritas 0.4.5.
//!
//! Run inside libveritas source d2cb558830adfdfcc44613591d2c0329160fcd3b:
//! cargo run --locked -p libveritas_testutil --example freedom_spaces_member_fixture
//! Every message verifies with production options. First commitments need no
//! ZK receipt, so neither fake receipts nor VERIFY_DEV_MODE are used.
use bitcoin::ScriptBuf;
use bitcoin::key::Keypair;
use bitcoin::secp256k1::Secp256k1;
use libveritas::msg::{Message, QueryContext, UnsignedRecordSet};
use libveritas::{SovereigntyState, Zone};
use libveritas_testutil::fixture::{ChainState, Fixture, FixtureRunner};
use libveritas_testutil::{sign_mesage, sname};
use serde_json::{Map, Value, json};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn signed(handle: &str, records: Vec<sip7::Record>, key: &Keypair) -> sip7::RecordSet {
    let unsigned = UnsignedRecordSet {
        handle: sname(handle),
        canonical: sname(handle),
        flags: sip7::SIG_PRIMARY_ZONE,
        records: sip7::RecordSet::pack(records).expect("pack records"),
        delegate: false,
    };
    let signature = sign_mesage(&unsigned.signable_bytes(), key);
    unsigned.pack_sig(signature.0.to_vec())
}

fn website(handle: &str, url: &str, seq: u32, key: &Keypair) -> sip7::RecordSet {
    signed(
        handle,
        vec![
            sip7::Record::seq(seq.into()),
            sip7::Record::txt("website", &[url]),
        ],
        key,
    )
}

fn verify(state: &ChainState, message: Message, handle: &str) -> Zone {
    let mut context = QueryContext::new();
    context.add_request(sname(handle));
    state
        .veritas()
        .verify_with_options(&context, message, libveritas::VERIFY_DEFAULT)
        .expect("member message verifies with production options")
        .zones
        .into_iter()
        .find(|zone| zone.canonical.to_string() == handle)
        .expect("requested member is verified")
}

fn generate(space: &'static str, committed: bool, finalized: bool) -> Value {
    let mut fixture = Fixture::new(space).stage(&["member"]);
    if committed {
        fixture = fixture.commit();
    }
    if finalized {
        fixture = fixture.finalize();
    }
    let mut state = ChainState::new();
    let mut runner = FixtureRunner::new(&mut state, fixture);
    runner.run(&mut state);
    // The first commitment requires no receipt or historical context.
    state.anchors.clear();
    state.anchors.push(state.chain.current_root_anchor());
    let key = if committed {
        runner.handles.commitments[0]
            .handles
            .values()
            .next()
            .expect("one committed member")
            .keypair
    } else {
        runner
            .handles
            .staged
            .values()
            .next()
            .expect("one staged member")
            .handle
            .keypair
    };
    let handle = format!("member{space}");
    let foreign = Keypair::from_seckey_slice(&Secp256k1::new(), &[7u8; 32]).expect("fixture key");
    let mut bundle = runner.build_bundle();
    assert!(bundle.receipt.is_none(), "fixture must not use any receipt");
    bundle.records = Some(website(
        space,
        "https://example.org/parent-only",
        1,
        &runner.space.space.keypair,
    ));
    let base = state.message(vec![bundle]);
    let expected = if finalized {
        SovereigntyState::Sovereign
    } else if committed {
        SovereigntyState::Pending
    } else {
        SovereigntyState::Dependent
    };
    let mut variants = vec![
        (
            "website",
            website(&handle, "https://example.com/member", 1, &key),
            true,
        ),
        (
            "website-seq2",
            website(&handle, "https://example.org/member-next", 2, &key),
            true,
        ),
        (
            "http",
            website(&handle, "http://example.com/member", 1, &key),
            true,
        ),
        (
            "foreign-key",
            website(&handle, "https://example.com/forged", 1, &foreign),
            false,
        ),
        (
            "other-name",
            website(
                &format!("other{space}"),
                "https://example.com/wrong-name",
                1,
                &key,
            ),
            false,
        ),
        (
            "parent-name",
            website(space, "https://example.com/wrong-parent", 1, &key),
            false,
        ),
        (
            "no-website",
            signed(&handle, vec![sip7::Record::seq(1)], &key),
            true,
        ),
        (
            "two-values",
            signed(
                &handle,
                vec![
                    sip7::Record::seq(1),
                    sip7::Record::txt("website", &["https://example.com/", "https://example.org/"]),
                ],
                &key,
            ),
            true,
        ),
    ];
    let mut corrupted = website(&handle, "https://example.com/corrupt", 1, &key)
        .as_slice()
        .to_vec();
    let last = corrupted.len() - 1;
    corrupted[last] ^= 1;
    variants.push(("bad-signature", sip7::RecordSet::new(corrupted), false));
    let mut records = Map::new();
    for (name, set, has_records) in variants {
        let mut message = base.clone();
        message.set_records(&sname(&handle), set.clone());
        let zone = verify(&state, message, &handle);
        assert_eq!(zone.sovereignty, expected);
        assert_eq!(!zone.records.is_empty(), has_records, "{name}");
        records.insert(name.to_string(), json!(hex(set.as_slice())));
    }
    let mut anchors = state.anchors.clone();
    anchors.reverse();
    let mut context = QueryContext::new();
    context.add_request(sname(&handle));
    let mut wrong_genesis = base.clone();
    let mut forged_spk = vec![0x51, 0x20];
    forged_spk.extend_from_slice(&foreign.x_only_public_key().0.serialize());
    wrong_genesis.spaces[0].epochs[0].handles[0].genesis_spk = ScriptBuf::from_bytes(forged_spk);
    assert!(
        state
            .veritas()
            .verify_with_options(&context, wrong_genesis.clone(), libveritas::VERIFY_DEFAULT)
            .is_err()
    );
    let mut parent_only = base.clone();
    parent_only.spaces[0].epochs.clear();
    let parent_result = state
        .veritas()
        .verify_with_options(&context, parent_only.clone(), libveritas::VERIFY_DEFAULT)
        .expect("parent-only message verifies");
    assert!(
        !parent_result
            .zones
            .iter()
            .any(|zone| zone.canonical.to_string() == handle)
    );
    json!({
        "handle": handle,
        "parent": space,
        "sovereignty": expected,
        "anchors": anchors,
        "message": hex(&base.to_bytes()),
        "ownerKey": hex(&key.x_only_public_key().0.serialize()),
        "records": records,
        "wrongGenesisMessage": hex(&wrong_genesis.to_bytes()),
        "parentOnlyMessage": hex(&parent_only.to_bytes()),
    })
}

fn main() {
    let output = json!({
        "generator": "libveritas 0.4.5 at d2cb558830adfdfcc44613591d2c0329160fcd3b; production options; no ZK receipts",
        "sovereign": generate("@memberspace", true, true),
        "pending": generate("@pending-space", true, false),
        "dependent": generate("@temporary-space", false, false),
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&output).expect("fixture JSON")
    );
}

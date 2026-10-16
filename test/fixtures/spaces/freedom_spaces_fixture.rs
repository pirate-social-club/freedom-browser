//! Freedom browser test fixture for verified Spaces browsing.
//!
//! Builds two simulated chains with libveritas_testutil, each holding one root
//! space and no handles, so the messages verify with the production options
//! (no fake ZK receipts):
//!
//! - `@example`, with no delegate, and SIP-7 record sets signed by its owner
//!   key (one at sequence 2, the rest at 1, plus one signed by an unrelated
//!   key and one signed for another name);
//! - `@delegated`, whose delegate signs a record set carrying a website.
//!
//! Every testutil key comes from the same zero-seeded generator, so the record
//! sets are deterministic. Run from a libveritas v0.4.5 checkout:
//!   cargo run --locked -p libveritas_testutil --example freedom_spaces_fixture > generated-chain.json
use bitcoin::key::Keypair;
use bitcoin::secp256k1::Secp256k1;
use libveritas::compute_trust_set;
use libveritas::msg::{self, QueryContext, UnsignedRecordSet};
use libveritas_testutil::fixture::ChainState;
use libveritas_testutil::{gen_p2tr_spk, sign_mesage, sname};
use serde_json::{Map, Value, json};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn signed(space: &str, records: Vec<sip7::Record>, keypair: &Keypair, delegate: bool) -> sip7::RecordSet {
    let name = sname(space);
    let unsigned = UnsignedRecordSet {
        handle: name.clone(),
        canonical: name,
        flags: 0,
        records: sip7::RecordSet::pack(records).expect("pack records"),
        delegate,
    };
    let sig = sign_mesage(&unsigned.signable_bytes(), keypair);
    unsigned.pack_sig(sig.0.to_vec())
}

fn website(urls: &[&str]) -> Vec<sip7::Record> {
    vec![sip7::Record::seq(1), sip7::Record::txt("website", urls)]
}

struct Chain {
    state: ChainState,
    bundle: msg::Bundle,
}

fn chain(space: &str, delegated: bool) -> Chain {
    let mut state = ChainState::new();
    let label = if delegated {
        state.chain.add_space_with_delegation(space).space.label()
    } else {
        state.chain.add_space(space).label()
    };
    state.chain.increase_time(144);
    state.anchors.push(state.chain.current_root_anchor());
    let bundle = msg::Bundle {
        subject: label,
        receipt: None,
        records: None,
        delegate_records: None,
        epochs: vec![],
    };
    Chain { state, bundle }
}

fn verify(c: &Chain, bundle: msg::Bundle) -> Vec<u8> {
    let message = c.state.message(vec![bundle]);
    let bytes = message.to_bytes();
    let result = c
        .state
        .veritas()
        .verify_with_options(&QueryContext::new(), message, 0)
        .expect("fixture verifies without dev mode");
    for zone in &result.zones {
        eprintln!(
            "{} sovereignty {} owner records {} bytes",
            zone.handle,
            zone.sovereignty,
            zone.records.as_slice().len()
        );
    }
    bytes
}

fn anchors_json(c: &Chain) -> Value {
    let mut anchors = c.state.anchors.clone();
    anchors.reverse();
    serde_json::to_value(&anchors).expect("anchors json")
}

fn main() {
    let (_, owner) = gen_p2tr_spk();
    let foreign = Keypair::from_seckey_slice(&Secp256k1::new(), &[7u8; 32]).expect("foreign key");

    let root = chain("@example", false);
    let mut records = Map::new();
    let variants: Vec<(&str, sip7::RecordSet)> = vec![
        ("website", signed("@example", website(&["https://example.com/"]), &owner, false)),
        ("website-path", signed("@example", website(&["https://example.com/c/@example"]), &owner, false)),
        (
            "website-seq2",
            signed(
                "@example",
                vec![sip7::Record::seq(2), sip7::Record::txt("website", &["https://example.org/next"])],
                &owner,
                false,
            ),
        ),
        ("http", signed("@example", website(&["http://example.com/"]), &owner, false)),
        ("two-values", signed("@example", website(&["https://example.com/", "https://example.org/"]), &owner, false)),
        (
            "two-records",
            signed(
                "@example",
                vec![
                    sip7::Record::seq(1),
                    sip7::Record::txt("website", &["https://example.com/"]),
                    sip7::Record::txt("website", &["https://example.org/"]),
                ],
                &owner,
                false,
            ),
        ),
        ("no-website", signed("@example", vec![sip7::Record::seq(1), sip7::Record::txt("btc", &["bc1qtest"])], &owner, false)),
        ("foreign-key", signed("@example", website(&["https://example.com/"]), &foreign, false)),
        ("other-name", signed("@other", website(&["https://example.com/"]), &owner, false)),
    ];
    for (name, set) in variants {
        let mut bundle = root.bundle.clone();
        bundle.records = Some(set.clone());
        eprint!("{name}: ");
        verify(&root, bundle);
        records.insert(name.to_string(), json!(hex(set.as_slice())));
    }

    let delegated = chain("@delegated", true);
    let mut bundle = delegated.bundle.clone();
    bundle.delegate_records = Some(signed("@delegated", website(&["https://example.com/"]), &owner, true));
    eprint!("delegate website: ");
    let delegated_message = verify(&delegated, bundle);

    let out = json!({
        "generator": "libveritas v0.4.5 testutil/examples/freedom_spaces_fixture.rs",
        "ownerKey": hex(&owner.x_only_public_key().0.serialize()),
        "root": {
            "space": "@example",
            "anchors": anchors_json(&root),
            "trustId": hex(&compute_trust_set(&root.state.anchors).id),
            "message": hex(&verify(&root, root.bundle.clone())),
            "records": records,
        },
        "delegated": {
            "space": "@delegated",
            "anchors": anchors_json(&delegated),
            "message": hex(&delegated_message),
        },
    });
    println!("{}", serde_json::to_string_pretty(&out).expect("json"));
}

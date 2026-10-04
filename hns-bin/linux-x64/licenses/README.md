# HNS helper sources and notices

source-record.json identifies the exact daemon and proxy bytes and the source,
dependency and compiler archives used for these notices. Its notices list
uses paths relative to the containing hns-bin directory. Captured module
paths describe the evidence package, not installed files.

hnsd/source.tar retains the rebuilt daemon's complete source, including
libuv's additional ISC and BSD notices and embedded cryptography notices.
Selected original texts are also provided separately. BLAKE2b is used under
the offered Apache-2.0 terms, whose full text is included. The daemon links
to Ubuntu's libunbound8 and libc6 rather than distributing those libraries.

fingertipd retains its MIT text, checksum-bound Go dependency notices and
official Go compiler-source notices. Its executable is unchanged in this
checkpoint. No helper was executed while capturing or importing these texts.

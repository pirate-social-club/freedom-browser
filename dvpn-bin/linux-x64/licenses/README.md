# V2Ray notices

source-record.json identifies the exact v2ray bytes, the official release
archive they come from, and every Go module the binary embeds. Its notices
list uses paths relative to the containing dvpn-bin directory.

v2ray/ holds each embedded module's licence, copyright, notice and patent
files, copied unedited from the module's archive on proxy.golang.org at the
version the binary records. Each archive's digest is recorded, and each one
matches the h1 sum embedded in the binary. The file prefix is the module's
position in source-record.json, with 00 for v2ray-core itself. The go-*
files are Go 1.19.4's own notices for the standard library and the
golang.org/x packages it vendors.

The release archive also carries geoip.dat and geosite.dat. They are not
shipped, because V2Ray runs without them under the configuration this
browser generates, so no notices for them are included. No helper was
executed while capturing these texts.

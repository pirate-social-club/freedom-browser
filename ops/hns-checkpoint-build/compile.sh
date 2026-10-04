#!/usr/bin/env bash
# Runs without network access as the runner's ordinary UID.
set -euo pipefail
test "$(id -u)" -gt 0
test ! -e /output/source
mkdir /output/source /output/licenses
tar -xf /input/hnsd-source.tar -C /output/source
cp /input/hnsd-source.tar /output/hnsd-source.tar
cp /output/source/LICENSE /output/licenses/hnsd-MIT.txt
cp -a /usr/share/common-licenses /output/licenses/common-licenses
dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > /output/packages.tsv
while IFS=$'\t' read -r package _version _source _source_version; do
  doc="/usr/share/doc/${package%%:*}/copyright"
  if [[ -f "$doc" ]]; then cp -L "$doc" "/output/licenses/${package//:/_}.copyright"; fi
done < /output/packages.tsv
cp -a /etc/apt/sources.list.d /output/apt-sources
cc --version > /output/compiler.txt
ld --version > /output/linker.txt
cd /output/source
./autogen.sh
./configure --disable-shared --enable-static
make -j1 V=1
cp hnsd /output/hnsd
readelf -l /output/hnsd > /output/elf-program-headers.txt
readelf -d /output/hnsd > /output/elf-dynamic.txt
readelf --version-info /output/hnsd > /output/elf-versions.txt
# Refuse a fully static artifact; acceptance will map actual SONAMEs to deb dependencies.
test "$(readelf -l /output/hnsd | sed -n '/INTERP/p' | wc -l)" -eq 1
readelf -d /output/hnsd | sed -n '/NEEDED/p' > /output/needed-libraries.txt
test -s /output/needed-libraries.txt
sha256sum /output/hnsd /output/hnsd-source.tar > /output/artifact-sha256.txt

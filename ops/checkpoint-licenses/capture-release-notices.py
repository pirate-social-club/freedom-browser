"""Retain release-project and historical geodata notices without executing helpers."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

SOURCES = {
    'bee': [('https://raw.githubusercontent.com/ethersphere/bee/v2.8.1/LICENSE', 'LICENSE')],
    'ipfs': [('https://raw.githubusercontent.com/ipfs/kubo/v0.43.0/' + name, name)
             for name in ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE']],
    'v2ray': [('https://raw.githubusercontent.com/v2fly/v2ray-core/v5.2.1/LICENSE', 'LICENSE')],
    'v2ray-geodata': [
        ('https://raw.githubusercontent.com/v2fly/geoip/fa604c3e5e5343b56bff50f021d621ae74b0fb4f/LICENSE', 'geoip-LICENSE-CC-BY-SA-4.0'),
        ('https://raw.githubusercontent.com/v2fly/geoip/fa604c3e5e5343b56bff50f021d621ae74b0fb4f/README.md', 'geoip-historical-attribution.md'),
        ('https://raw.githubusercontent.com/v2fly/domain-list-community/128c6228a467fadd10eeeff8310ecb07f0a61f2e/LICENSE', 'geosite-LICENSE-MIT')],
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-directory', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print('Plan: retain original helper-project and historical data notices')
        return
    for component, entries in SOURCES.items():
        destination = args.output_directory / component
        destination.mkdir(parents=True, exist_ok=True)
        records = []
        for url, name in entries:
            content = urllib.request.urlopen(url, timeout=60).read()
            assert content and len(content) < 1048576, 'notice_size'
            (destination / name).write_bytes(content)
            records.append({'path': name, 'source_url': url, 'sha256': hashlib.sha256(content).hexdigest()})
        (destination / 'release-notice-record.json').write_text(json.dumps({
            'component': component, 'notices': records,
            'scope': 'Original release-project license texts; compiler and dependency notices have separate records.',
            'executed_target': False}, indent=2) + '\n')
        print('Retained original notices for', component, flush=True)


if __name__ == '__main__':
    main()

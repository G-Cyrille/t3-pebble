"""Package only runtime files. SDK source maps contain machine-specific paths."""
import hashlib
import json
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
source = root / 'build/t3-pebble.pbw'
target = root / 'build' / ('t3-pebble-v%s.pbw' % version)
with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as dst:
    for name in sorted(src.namelist()):
        if name.endswith('.map'):
            continue
        data = src.read(name)
        if name.endswith('.js'):
            data = re.sub(rb'(?m)^//# sourceMappingURL=.*\n?', b'', data)
        if re.search(rb'/(?:home|Users)/[^/\s"\\]+/', data):
            raise SystemExit('Local filesystem path in release: ' + name)
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        dst.writestr(info, data)
    dst.writestr('LICENSE.txt', (root / 'LICENSE').read_bytes())
    dst.writestr('THIRD_PARTY_NOTICES.txt', (root / 'THIRD_PARTY_NOTICES.md').read_bytes())
checksum = hashlib.sha256(target.read_bytes()).hexdigest()
(root / 'build/SHA256SUMS').write_text(checksum + '  ' + target.name + '\n')
print(target.name + ': ' + checksum)

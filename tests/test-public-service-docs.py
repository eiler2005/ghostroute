#!/usr/bin/env python3
"""Keep service-egress publication independent of one operator's application."""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1]
application = re.compile(r'(?i:' + 'max' + r'tg)|\b' + 'M' + r'AX(?:_EGRESS\w*)?\b(?!\s*\()')
retired = {'ghostroute-architecture-concept.png', 'ghostroute-runtime-map-detailed.png', 'ghostroute-architecture-ru.png'}
files = subprocess.check_output(['git', 'ls-files'], cwd=root, text=True).splitlines()
errors = []
for name in files:
    path = root / name
    if not path.is_file():
        continue
    if path.name in retired:
        errors.append(name + ': retired raster publication')
    if path.suffix not in ('.md', '.html', '.svg'):
        continue
    text = path.read_text()
    if application.search(text):
        errors.append(name + ': application-specific service description')
    if any(value in text for value in retired):
        errors.append(name + ': reference to retired raster publication')
for name in ('README.md', 'README-ru.md'):
    text = (root / name).read_text()
    if not re.search(r'regional|регион', text, re.I):
        errors.append(name + ': missing abstract regional capability')
if errors:
    raise SystemExit('\n'.join(errors))
print('public service documentation privacy checks passed')

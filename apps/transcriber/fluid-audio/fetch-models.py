#!/usr/bin/env python3
"""Provision immutable public CoreML artifacts; runtime remains offline."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

base = Path(sys.argv[1])
lock = json.loads(Path(__file__).with_name('models.lock.json').read_text())
for item in lock['files']:
    target = base / item['path']
    def valid(path):
        return path.is_file() and path.stat().st_size == item['size'] and hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == item['sha256']
    if valid(target):
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + '.tmp-' + str(uuid.uuid4()))
    try:
        subprocess.run(['/usr/bin/curl', '--fail', '--location', '--retry', '3', '--max-time', '300', '--silent', '--show-error', '--output', str(temp), item['url']], check=True)
        if not valid(temp):
            raise RuntimeError('model checksum mismatch: ' + item['path'])
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
print('Verified', len(lock['files']), 'pinned CoreML files')

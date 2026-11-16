"""Read bounded, private Channel D access logs into the atomic interval spool."""
import hashlib
import json
import os
from pathlib import Path

from channel_d_log import parse_record, validate_profiles


def collect(db, state_dir, profiles_path, now):
    profiles = validate_profiles(json.loads(Path(profiles_path).read_text()))
    state = Path(state_dir)
    candidates = sorted(state.glob('channel-d-access-*.log')) + [state / 'channel-d-access.log']
    available = False
    for path in candidates:
        if not path.is_file() or path.is_symlink():
            continue
        available = True
        with path.open('rb') as stream:
            stat = os.fstat(stream.fileno())
            first = stream.readline(65537)
            if not first:
                continue
            if len(first) > 65536 or not first.endswith(b'\n'):
                raise ValueError('invalid first log line')
            file_id = '%s:%s:%s' % (stat.st_dev, stat.st_ino, hashlib.sha256(first).hexdigest())
            entry = db.execute('select offset from log_cursors where file_id = ?', (file_id,)).fetchone()
            offset = entry[0] if entry else 0
            if stat.st_size < offset:
                raise ValueError('log truncated before consumption')
            stream.seek(offset)
            with db:
                for _ in range(10000):
                    line_offset = stream.tell()
                    raw = stream.readline(65537)
                    if not raw:
                        break
                    if len(raw) > 65536:
                        raise ValueError('oversized log record')
                    if not raw.endswith(b'\n'):
                        stream.seek(line_offset)
                        break
                    try:
                        row, gap = parse_record(raw, profiles, file_id, line_offset)
                    except (ValueError, TypeError, OverflowError):
                        row, gap = None, 'invalid_log'
                    if row:
                        db.execute('insert or ignore into intervals values (?, ?, ?)',
                                   (row['sample_id'], row['ts'], json.dumps(row, separators=(',', ':'))))
                    if gap:
                        db.execute('insert into gaps values (?, ?, ?)', ('D', now, gap))
                db.execute('insert or replace into log_cursors values (?, ?, ?)', (file_id, stream.tell(), now))
    return available

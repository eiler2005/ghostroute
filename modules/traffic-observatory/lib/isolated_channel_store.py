"""Atomic state and interval spool for isolated-channel counter samples."""
import json
import sqlite3
from datetime import datetime

from isolated_channel_collector import profile_counters, profile_intervals


def initialize(db):
    db.execute('create table if not exists state (channel text primary key, sample text not null)')
    db.execute('create table if not exists intervals (sample_id text primary key, ts text not null, payload text not null)')
    db.execute('create table if not exists gaps (channel text not null, ts text not null, reason text not null)')
    db.execute('create table if not exists status (channel text primary key, available integer not null)')
    db.execute('create table if not exists log_cursors (file_id text primary key, offset integer not null, updated_ts text not null)')
    db.commit()


def ingest(db, sample):
    """Commit new baseline and its deltas together, including explicit gaps."""
    channel = sample['channel']
    stamp = datetime.fromisoformat(sample['ts'].replace('Z', '+00:00'))
    if stamp.tzinfo is None or not sample.get('instance_id'):
        raise ValueError('sample requires timezone and process identity')
    profile_counters(channel, sample['stats'])
    with db:
        entry = db.execute('select sample from state where channel = ?', (channel,)).fetchone()
        rows, gaps = profile_intervals(json.loads(entry[0]), sample) if entry else ([], ['initial_baseline'])
        for row in rows:
            db.execute('insert or ignore into intervals values (?, ?, ?)', (row['sample_id'], row['ts'], json.dumps(row, separators=(',', ':'))))
        for reason in gaps:
            db.execute('insert into gaps values (?, ?, ?)', (channel, sample['ts'], reason))
        db.execute('insert or replace into state values (?, ?)', (channel, json.dumps(sample, separators=(',', ':'))))
        db.execute('insert or replace into status values (?, 1)', (channel,))
    return len(rows), gaps


def open_store(path):
    db = sqlite3.connect(path, timeout=10)
    initialize(db)
    return db


def record_gap(db, channel, timestamp, reason):
    if channel not in ('anyT', 'Snell', 'Amn', 'D') or reason not in ('sampling_failed', 'inactive'):
        raise ValueError('invalid gap')
    with db:
        status = db.execute('select available from status where channel = ?', (channel,)).fetchone()
        if not status or status[0] != 0:
            db.execute('insert into gaps values (?, ?, ?)', (channel, timestamp, reason))
        db.execute('insert or replace into status values (?, 0)', (channel,))

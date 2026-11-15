import importlib.machinery
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

path = Path(__file__).resolve().parents[1] / 'bin/reset-traffic-history'
loader = importlib.machinery.SourceFileLoader('reset_traffic', str(path))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class ResetTest(unittest.TestCase):
    def test_removes_history_preserving_settings_schema_and_health(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'ghostroute.db'
            db = sqlite3.connect(path)
            db.executescript('''
                pragma journal_mode=WAL;
                create table snapshots(id integer primary key, type text, payload_json text);
                create table traffic_facts(id integer primary key, bytes integer, raw_json text);
                create index traffic_bytes on traffic_facts(bytes);
                create table client_traffic_hourly(id integer primary key, bytes integer);
                create table console_settings(key text primary key, value text);
                create table audit_log(id integer primary key, action text);
                create table custom_operator_state(id integer primary key, payload blob);
                insert into snapshots values(1,'health','{}'),(2,'traffic_facts','old-history'),(3,'channel_health','{}');
                insert into console_settings values('preference','keep');
                insert into audit_log values(1,'review');
                insert into custom_operator_state values(1,X'0102');
                insert into client_traffic_hourly values(1,100);
            ''')
            db.executemany('insert into traffic_facts values(?,?,?)', [(i, 100, 'x' * 4096) for i in range(1, 101)])
            db.commit()
            db.close()
            result = module.reset(path)
            self.assertLess(result['bytes_after'], result['bytes_before'])
            db = sqlite3.connect(path)
            self.assertEqual(db.execute('select count(*) from traffic_facts').fetchone()[0], 0)
            self.assertEqual(db.execute('select count(*) from client_traffic_hourly').fetchone()[0], 0)
            self.assertEqual(db.execute('select type from snapshots order by id').fetchall(), [('health',), ('channel_health',)])
            self.assertEqual(db.execute('select value from console_settings').fetchone()[0], 'keep')
            self.assertEqual(db.execute('select action from audit_log').fetchone()[0], 'review')
            self.assertEqual(db.execute('select payload from custom_operator_state').fetchone()[0], b'\x01\x02')
            self.assertEqual(db.execute('pragma integrity_check').fetchone()[0], 'ok')
            self.assertIsNotNone(db.execute("select name from sqlite_master where name='traffic_bytes'").fetchone())
            db.close()

    def test_busy_database_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'ghostroute.db'
            db = sqlite3.connect(path)
            db.executescript('pragma journal_mode=WAL; create table traffic_facts(id integer primary key); insert into traffic_facts values(1);')
            db.execute('begin immediate')
            with self.assertRaises((RuntimeError, sqlite3.OperationalError)):
                module.reset(path)
            db.rollback()
            self.assertEqual(db.execute('select count(*) from traffic_facts').fetchone()[0], 1)
            self.assertFalse(path.with_name(path.name + '.traffic-reset.tmp').exists())
            db.close()


if __name__ == '__main__':
    unittest.main()

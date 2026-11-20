import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('policy', ROOT/'modules/routing-core/router/channel-anytls-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
runtime_spec = importlib.util.spec_from_file_location('runtime',ROOT/'modules/routing-core/router/channel-anytls.py')
runtime = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime)


class ConnectionLoggingTest(unittest.TestCase):
    def test_enabled_watch_compacts_before_the_containment_budget_check(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            (base/'channel-anytls-policy.py').write_text((ROOT/'modules/routing-core/router/channel-anytls-policy.py').read_text())
            (base/'observability.json').write_text('{"connection_events":true}')
            (base/'inputs.sha256').write_text('fixture')
            (base/'policy.log').write_bytes(b'event\n'*(3*1024*1024//6))
            with mock.patch.object(runtime,'BASE',base),mock.patch.object(runtime,'RUN',base), \
                mock.patch.object(runtime,'owned_pid',side_effect=[True,False]), \
                mock.patch.object(runtime,'input_signature',return_value='fixture'), \
                mock.patch.object(runtime.signal,'signal'),mock.patch.object(runtime.time,'sleep'), \
                mock.patch.object(runtime,'terminate') as terminate:
                runtime.watch()
            self.assertLessEqual((base/'policy.log').stat().st_size,1024*1024)
            self.assertFalse((base/'contained.txt').exists())
            terminate.assert_called_once_with('policy')

    def test_policy_stdio_also_uses_append_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            def process(argv,**kwargs):
                self.assertIn('a',kwargs['stdout'].mode)
                return mock.Mock(pid=999)
            with mock.patch.object(runtime,'RUN',base),mock.patch.object(runtime.subprocess,'Popen',side_effect=process):
                runtime.spawn('policy',['fixture'])

    def test_logging_is_explicit_and_changes_no_routing_or_identity(self):
        original = {'log':{'level':'warn','output':'/fixture/policy.log','timestamp':True},
            'inbounds':[{'type':'anytls','users':[{'name':'fixture','password':'fixture-placeholder'}]}],
            'route':{'final':'direct-out'},'outbounds':[{'tag':'reality-out'}]}
        for options in ({},{'connection_events':False},{'connection_events':'true'},{'connection_events':1}):
            config = copy.deepcopy(original)
            self.assertFalse(policy.connection_logging(config,options))
            self.assertEqual(config,original)
        config = copy.deepcopy(original)
        self.assertTrue(policy.connection_logging(config,{'connection_events':True}))
        expected = copy.deepcopy(original)
        expected['log']['level'] = 'info'
        self.assertEqual(config,expected)

    def test_compaction_preserves_append_writer_and_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'policy.log'
            file.write_bytes(b'fixture-event\n'*(3*1024*1024//14))
            inode=file.stat().st_ino
            with file.open('ab') as writer:
                self.assertTrue(policy.compact_connection_log(file))
                self.assertLessEqual(file.stat().st_size,1024*1024)
                writer.write(b'new-event\n')
            self.assertEqual(file.stat().st_ino,inode)
            data=file.read_bytes()
            self.assertNotIn(b'\0',data)
            self.assertTrue(data.endswith(b'new-event\n'))
            self.assertFalse(policy.compact_connection_log(file))

    def test_missing_or_small_log_needs_no_rewrite(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'policy.log'
            self.assertFalse(policy.compact_connection_log(file))
            file.write_text('small\n')
            before=file.stat().st_mtime_ns
            self.assertFalse(policy.compact_connection_log(file))
            self.assertEqual(file.stat().st_mtime_ns,before)


if __name__ == '__main__':
    unittest.main()

import importlib.util, json, pathlib, runpy, sys, tempfile, unittest
from unittest.mock import patch

script=pathlib.Path(__file__).resolve().parents[1]/'router/activate-anyt-stats.py'

class ActivationTests(unittest.TestCase):
    def exercise(self, fail):
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary)
            base=root/'anyt';stage=root/'stage';backup=root/'observer'/'rollback-anyt'
            base.mkdir();stage.mkdir();backup.parent.mkdir()
            for name in ('channel-anytls-policy.py','channel-anytls.py'):
                (base/name).write_text('original-'+name);(stage/name).write_text('candidate-'+name)
            (base/'settings.json').write_text('{"fixture":"unchanged"}')
            (stage/'plan.json').write_text(json.dumps({'anyT':12099}))
            def mapped(value):
                return {'/opt/etc/ghostroute-anytls':base,'/tmp/ghostroute-channel-accounting-stage':stage,
                        '/opt/etc/ghostroute-observability/rollback-anyt':backup}.get(str(value),pathlib.PosixPath(value))
            def run(argv, **kwargs):
                if fail and argv[0]=='/opt/libexec/ghostroute-channel-stats': raise RuntimeError('fixture failure')
            state={'policy_running':True,'watch_running':True,'source_current':True}
            with patch('pathlib.Path',side_effect=mapped),patch('subprocess.run',side_effect=run),patch('subprocess.check_output',return_value=json.dumps(state).encode()),patch.object(sys,'argv',['fixture','enable']):
                if fail:
                    with self.assertRaises(RuntimeError): runpy.run_path(str(script))
                else: runpy.run_path(str(script))
            self.assertEqual((base/'settings.json').read_text(),'{"fixture":"unchanged"}')
            for name in ('channel-anytls-policy.py','channel-anytls.py'):
                self.assertEqual((base/name).read_text(),('original-' if fail else 'candidate-')+name)
            self.assertEqual((base/'observability.json').exists(),not fail)
    def test_success(self): self.exercise(False)
    def test_failure_restores_original(self): self.exercise(True)

if __name__=='__main__': unittest.main()

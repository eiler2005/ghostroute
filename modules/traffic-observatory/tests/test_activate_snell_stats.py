import json, pathlib, runpy, sys, tempfile, unittest
from unittest.mock import patch
script=pathlib.Path(__file__).resolve().parents[1]/'router/activate-snell-stats.py'

class ActivationTests(unittest.TestCase):
    def exercise(self, fail):
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary);base=root/'snell';stage=root/'stage';backup=root/'observer'/'rollback-snell'
            base.mkdir();stage.mkdir();backup.parent.mkdir()
            for name in ('channel-snell-policy.py','channel-snell.py'):
                (base/name).write_text('original-'+name);(stage/name).write_text('candidate-'+name)
            (base/'settings.json').write_text('{"fixture":"unchanged"}')
            (stage/'plan.json').write_text(json.dumps({'Snell':12100}))
            def mapped(value):
                return {'/opt/etc/ghostroute-snell':base,'/tmp/ghostroute-channel-accounting-stage':stage,
                        '/opt/etc/ghostroute-observability/rollback-snell':backup}.get(str(value),pathlib.PosixPath(value))
            actions=[]
            def run(argv,**kwargs):
                actions.append(argv[-1])
                if fail and argv[0]=='/opt/libexec/ghostroute-channel-stats':raise RuntimeError('fixture failure')
            state={'watch_running':True,'recent_policy_check':True}
            with patch('pathlib.Path',side_effect=mapped),patch('subprocess.run',side_effect=run),patch('subprocess.check_output',return_value=json.dumps(state).encode()),patch('socket.create_connection'),patch.object(sys,'argv',['fixture','enable']):
                if fail:
                    with self.assertRaises(RuntimeError):runpy.run_path(str(script))
                else:runpy.run_path(str(script))
            self.assertEqual((base/'settings.json').read_text(),'{"fixture":"unchanged"}')
            for name in ('channel-snell-policy.py','channel-snell.py'):
                self.assertEqual((base/name).read_text(),('original-' if fail else 'candidate-')+name)
            self.assertEqual((base/'observability.json').exists(),not fail)
            self.assertEqual(actions.count('start'),2 if fail else 1)
    def test_success(self):self.exercise(False)
    def test_failure_restores_original(self):self.exercise(True)

if __name__=='__main__':unittest.main()

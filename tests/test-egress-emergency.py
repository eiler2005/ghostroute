#!/usr/bin/env python3
"""Outage timing, transition failure injection and real OS lease coverage."""
from pathlib import Path
import fcntl
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import shutil
import socketserver
import threading

ROOT=Path(__file__).resolve().parents[1]
DIR=ROOT/'modules/routing-core/router'
policy=runpy.run_path(str(DIR/'egress-emergency-policy.py'))['observe']
module=runpy.run_path(str(DIR/'egress-emergency-controller.py'))
runtime=runpy.run_path(str(DIR/'egress-emergency-runtime.py'))

class FakeRuntime:
    def __init__(self, fail=None):
        self.fail=fail; self.events=[]; self.active='normal'; self.installed='normal'
    def snapshot(self): return {'anytls':True,'snell':True,'amn':False}
    def credentials(self): return {'fixture':'unchanged'}
    def stop(self): self.events.append('stop'); self.active=None
    def kill_probe(self): self.events.append('kill_probe')
    def qualify(self,role):
        assert self.active is None, 'Two profiles would be connected'
        self.events.append('probe:'+role)
        return self.fail!='qualification'
    def install(self,role):
        assert self.active is None
        self.events.append('install:'+role); self.installed=role
        if self.fail=='install' and role=='emergency': raise RuntimeError('fixture')
    def start(self,lanes,require_healthy=True):
        assert self.active is None
        self.events.append('start:'+self.installed); self.active=self.installed
        assert lanes['amn'] is False
    def health(self): return {'healthy':self.fail!='post'}

class PolicyTests(unittest.TestCase):
    def window(self, health=None, local=True):
        state={}
        for t in range(0,1801,300):state=policy(state,t,'boot',bool(health and t in health),local)
        return state
    def test_thirty_minutes(self):
        s={}
        for t in range(0,1800,300):
            s=policy(s,t,'boot',False,True);self.assertFalse(s['switch'])
        self.assertTrue(policy(s,1800,'boot',False,True)['switch'])
    def test_success_resets(self):self.assertFalse(self.window({900})['switch'])
    def test_local_failure_does_not_switch(self):self.assertFalse(self.window(local=False)['switch'])
    def test_reboot_resets(self):self.assertFalse(policy(self.window(),1801,'new',False,True)['switch'])
    def test_sample_gap_resets(self):self.assertFalse(policy(self.window(),2400,'boot',False,True)['switch'])
    def test_clock_backwards_resets(self):self.assertFalse(policy(self.window(),1,'boot',False,True)['switch'])
    def test_target_specific_partial_outage_resets(self):self.assertFalse(self.window(set(range(0,1801,300)))['switch'])

class TransitionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name)
        self.globals=module['transition'].__globals__;self.previous=self.globals['BASE'];self.globals['BASE']=self.base
    def tearDown(self):self.globals['BASE']=self.previous;self.tmp.cleanup()
    def transition(self, fake):return module['transition'](fake,'emergency',{'selected':'normal'},runtime['atomic'])
    def test_serial_success_latches(self):
        f=FakeRuntime();state=self.transition(f)
        self.assertEqual(f.events,['stop','probe:emergency','install:emergency','start:emergency'])
        self.assertTrue(state['latched']);self.assertFalse((self.base/'transition.json').exists())
    def test_failures_stop_candidate_before_restore(self):
        for stage in ['qualification','install','post']:
            with self.subTest(stage=stage):
                f=FakeRuntime(stage);state=self.transition(f)
                self.assertEqual(f.active,'normal');self.assertFalse(state['last_transition_ok'])
                self.assertEqual(f.events[-4:],['kill_probe','stop','install:normal','start:normal'])
    def test_failed_restore_keeps_recovery_marker(self):
        f=FakeRuntime('qualification')
        def fail(role):raise RuntimeError('restore failed')
        f.install=fail
        with self.assertRaises(RuntimeError):self.transition(f)
        self.assertTrue((self.base/'transition.json').exists())
    def test_interrupted_transition_restores_serially(self):
        runtime['atomic'](self.base/'transition.json',{'previous':'normal','lanes':FakeRuntime().snapshot()})
        f=FakeRuntime();f.active='emergency'
        module['recover'](f,runtime['atomic'])
        self.assertEqual(f.events,['kill_probe','stop','install:normal','start:normal'])
        self.assertFalse((self.base/'transition.json').exists())
    def test_changed_profiles_invalidate_qualification(self):
        import hashlib
        profiles=self.base/'profiles.json';profiles.write_text('fixture')
        runtime['atomic'](self.base/'drill-result.json',{'last_transition_ok':True,'qualification_version':module['QUALIFICATION_VERSION'],'profiles_digest':hashlib.sha256(profiles.read_bytes()).hexdigest()})
        self.assertTrue(module['proof_current']())
        profiles.write_text('different fixture')
        self.assertFalse(module['proof_current']())
    def test_old_edge_only_qualification_cannot_enable(self):
        import hashlib
        profiles=self.base/'profiles.json';profiles.write_text('fixture')
        runtime['atomic'](self.base/'drill-result.json',{'last_transition_ok':True,'profiles_digest':hashlib.sha256(profiles.read_bytes()).hexdigest()})
        self.assertFalse(module['proof_current']())
    def test_busy_manual_lease_is_not_a_successful_noop(self):
        path=self.base/'lease'
        with path.open('a') as shared,path.open('a') as exclusive:
            fcntl.flock(shared,fcntl.LOCK_SH)
            self.assertFalse(module['acquire'](exclusive,wait=False))
            with self.assertRaises(TimeoutError):module['acquire'](exclusive,wait=True,timeout=0)

class PreservationTests(unittest.TestCase):
    def test_orphan_probe_without_pid_is_stopped_but_other_programs_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);proc=base/'proc';proc.mkdir()
            for pid,binary in [('10',str(base/'gr-emergency-probe')),('11','/unrelated/gr-emergency-probe')]:
                (proc/pid).mkdir();(proc/pid/'cmdline').write_bytes(binary.encode()+b'\0run\0')
            kill=[]
            def stop(pid,signal):kill.append(pid);(proc/str(pid)/'cmdline').write_bytes(b'')
            def path(value):return proc if value=='/proc' else Path(value)
            function=runtime['Runtime'].kill_probe
            with mock.patch.dict(function.__globals__,BASE=base,Path=path),mock.patch.object(os,'kill',side_effect=stop):
                function(None)
            self.assertEqual(kill,[10]);self.assertTrue((proc/'11'/'cmdline').read_bytes())
    def test_profiles_rules_and_channels_preserved(self):
        profiles={'normal':{'type':'vless','uuid':'fixture-one'},'emergency':{'type':'vless','uuid':'fixture-two'}}
        source={'inbounds':[{'users':['issued-fixture']}],'dns':{'fixture':True},'route':{'rules':['unchanged']},'outbounds':[dict(profiles['normal'],tag=t) for t in ['reality-out','sensitive-out']]+[{'type':'direct','tag':'direct-out'}]}
        new=runtime['candidate'](source,profiles,'emergency')
        for key in ['inbounds','dns','route']:self.assertEqual(source[key],new[key])
        self.assertEqual(new['outbounds'][-1],source['outbounds'][-1])
        self.assertEqual({o.get('uuid') for o in new['outbounds'] if o['type']=='vless'},{'fixture-two'})
        self.assertEqual(runtime['candidate'](new,profiles,'normal'),source)
    def test_unknown_manual_config_refused(self):
        with self.assertRaises(ValueError):runtime['candidate']({'outbounds':[]},{'normal':{},'emergency':{}},'emergency')
    def test_shared_and_exclusive_leases_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'lock'
            with path.open('a') as held:
                fcntl.flock(held,fcntl.LOCK_SH)
                code='import fcntl,sys\nf=open(sys.argv[1],"a")\ntry:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(3)'
                self.assertEqual(subprocess.run([sys.executable,'-c',code,str(path)]).returncode,3)
            self.assertEqual(subprocess.run([sys.executable,'-c',code,str(path)]).returncode,0)
    def test_guard_does_not_leak_lease_to_background_daemon(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);lock=base/'lock';script=base/'guard.py'
            source=(DIR/'egress-emergency-guard.py').read_text().replace("Path('/tmp/ghostroute-egress-emergency.lock')",'Path('+repr(str(lock))+')').replace("Path('/opt/etc/ghostroute-egress-emergency')",'Path('+repr(str(base))+')')
            script.write_text(source)
            spawn='import subprocess,sys;subprocess.Popen([sys.executable,"-c","import time;time.sleep(1)"],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)'
            subprocess.run([sys.executable,str(script),'--',sys.executable,'-c',spawn],check=True,timeout=5)
            with lock.open('a') as held:fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def test_guard_refuses_unrelated_inherited_descriptor(self):
        guard=runpy.run_path(str(DIR/'egress-emergency-guard.py'))
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'right';path.touch()
            function=guard['inherited'];old=function.__globals__['LOCK'];function.__globals__['LOCK']=path
            with (Path(directory)/'wrong').open('w') as wrong:
                previous=os.environ.get('GR_EGRESS_LOCK_FD');os.environ['GR_EGRESS_LOCK_FD']=str(wrong.fileno())
                try:self.assertIsNone(function())
                finally:
                    function.__globals__['LOCK']=old
                    if previous is None:os.environ.pop('GR_EGRESS_LOCK_FD')
                    else:os.environ['GR_EGRESS_LOCK_FD']=previous

class ApplicationResponseTests(unittest.TestCase):
    """Real curl through a local SOCKS fixture: edge reachability is insufficient."""
    @classmethod
    def setUpClass(cls):
        cls.requests=[]
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                greeting=self.rfile.read(2);self.rfile.read(greeting[1]);self.wfile.write(b'\x05\x00');self.wfile.flush()
                header=self.rfile.read(4)
                if header[3]==3:self.rfile.read(self.rfile.read(1)[0])
                elif header[3]==1:self.rfile.read(4)
                self.rfile.read(2);self.wfile.write(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x50');self.wfile.flush()
                request=self.rfile.readline().decode().strip();cls.requests.append(request)
                while self.rfile.readline() not in (b'\r\n',b''):pass
                if '/region' in request:code,body='403',b'{"error":"unsupported_country_region_territory"}'
                elif '/challenge' in request:code,body='200',b'<title>Just a moment</title>'
                elif '/unexpected' in request:code,body='500',b'failure'
                elif '/empty' in request:code,body='401',b''
                else:code,body='401',b'{"error":"Unauthorized"}'
                self.wfile.write(('HTTP/1.1 '+code+' Fixture\r\nContent-Length: '+str(len(body))+'\r\nConnection: close\r\n\r\n').encode()+body)
        cls.server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def check(self,path,codes,method='GET'):
        function=runtime['http_check']
        with mock.patch.dict(function.__globals__,CURL=shutil.which('curl')):
            return function(self.server.server_address[1],'http://fixture.invalid/'+path,codes,method)
    def test_expected_unauthenticated_response_proves_transport(self):
        self.assertTrue(self.check('ok',['401'],'POST')['ok'])
        self.assertIn('POST /ok HTTP/1.1',self.requests)
    def test_region_block_is_not_healthy_even_if_code_allowed(self):self.assertFalse(self.check('region',['403'])['ok'])
    def test_edge_challenge_is_not_application_health(self):self.assertFalse(self.check('challenge',['200'])['ok'])
    def test_unexpected_status_fails(self):self.assertFalse(self.check('unexpected',['401'])['ok'])
    def test_empty_auth_response_fails(self):self.assertFalse(self.check('empty',['401'])['ok'])

if __name__=='__main__':unittest.main()

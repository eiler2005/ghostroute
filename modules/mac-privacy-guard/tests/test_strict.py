import socket
import threading
import time
import unittest

from mac_guard.chrome_events import validate_message
from mac_guard.policy import GuardError, catalog_digest
from mac_guard.service import Guard
from mac_guard.strict import StrictCoordinator

PROFILE = 'd' * 32


def config():
    return {'sensitive_domains':['sensitive.example.org'], 'routes':[
        {'id':'home', 'kind':'https_proxy', 'allowed_domains':['sensitive.example.org'],
         'probe_url':'https://sensitive.example.org/canary'}]}


class StrictTests(unittest.TestCase):
    def setUp(self):
        self.release = threading.Event()
        self.release.set()
        self.checker_fails = False
        def check(*_):
            self.release.wait(2)
            if self.checker_fails:raise GuardError('Fixture exit mismatch')
        self.parent = Guard(config())
        self.strict = StrictCoordinator(self.parent, factory=lambda _:object(), checker=check, system_check=lambda:True)
        self.parent.strict = self.parent.chrome.strict = self.strict
        self.strict.tick()

    def tearDown(self):
        self.strict.close()
        self.release.set()

    def report(self, profile=PROFILE, **fields):
        strict = dict(proxy='owned', catalog_digest=catalog_digest(self.parent.config['sensitive_domains']))
        strict.update(fields)
        message = dict(op='agent',profile=profile,ready=False,session=None,remaining=0,
                       reporting=True,protection=True,pause_remaining=0,strict=strict)
        self.parent.chrome.receive(validate_message(message))
        return self.parent.chrome.reply(profile)

    def wait(self, condition):
        for _ in range(100):
            if condition():return
            time.sleep(.01)
        self.fail_test('Fixture did not settle')

    def fail_test(self, message):raise AssertionError(message)

    def test_automatic_qualification_precedes_allow_and_manual_close_drains(self):
        self.release.clear()
        reply = self.report()
        self.assertEqual(reply['access'],'block')
        self.assertFalse(reply['strict']['ready'])
        self.release.set()
        self.wait(lambda:self.strict.sessions[PROFILE].guard.mode=='active')
        self.assertEqual(self.report()['access'],'allow')
        lane = self.strict.sessions[PROFILE].guard
        left,right = socket.socketpair()
        try:
            lane.connections.add(left)
            self.parent.chrome.command(PROFILE,'block_sites')
            self.assertEqual(left.fileno(),-1)
            self.assertEqual(self.parent.chrome.reply(PROFILE)['access'],'block')
            self.assertEqual(self.strict.sessions[PROFILE].reason,'paused')
            self.strict.tick()
            self.assertEqual(lane.mode,'locked')
        finally:right.close()
        self.assertEqual(self.parent.mode,'locked','Strict lane activated optional browser')
        self.assertTrue(any(e['reason']=='strict_active' for e in self.parent.activity()['events']))

    def test_close_during_qualification_cannot_be_undone_by_late_success(self):
        self.release.clear();self.report()
        self.parent.chrome.command(PROFILE,'block_sites')
        self.release.set()
        self.wait(lambda:not self.strict.sessions[PROFILE].checking)
        self.assertEqual(self.report()['access'],'block')

    def test_conflict_catalog_and_system_proxy_never_open(self):
        for change in ({'proxy':'conflict'}, {'proxy':'permission_required'}, {'catalog_digest':'f'*64}):
            reply = self.report(**change)
            self.assertEqual(reply['access'],'block')
            self.assertEqual(self.strict.sessions[PROFILE].guard.mode,'locked')
        self.strict.direct=False
        self.assertEqual(self.report()['strict']['reason'],'system_proxy')

    def test_failure_stale_evidence_and_legacy_bypass_are_closed(self):
        self.checker_fails=True;self.report()
        self.wait(lambda:not self.strict.sessions[PROFILE].checking)
        self.assertEqual(self.report()['access'],'block')
        self.assertEqual(self.report()['strict']['reason'],'route_failed')
        with self.assertRaises(GuardError):self.parent.chrome.command(PROFILE,'pause_protection')
        self.checker_fails=False
        self.strict.sessions[PROFILE].attempt-=6
        self.report()
        self.wait(lambda:self.strict.sessions[PROFILE].guard.mode=='active')
        lane=self.strict.sessions[PROFILE].guard
        lane.verified_at-=11
        self.release.clear()
        self.assertEqual(self.report()['access'],'block')
        self.assertNotEqual(lane.mode,'active')

    def test_unknown_or_ambiguous_route_and_bad_schemas(self):
        self.parent.config['routes'].append(dict(self.parent.config['routes'][0],id='another'))
        self.assertEqual(self.report()['strict']['reason'],'route_unavailable')
        self.assertEqual(len(self.strict.sessions),0)
        self.parent.config['routes'].pop()
        self.parent.config['routes'][0]['probe_url']='https://unlisted.example.org/'
        self.assertEqual(self.report()['access'],'block')
        for strict in ({'proxy':[],'catalog_digest':'a'*64}, {'proxy':'owned','catalog_digest':'bad'},
                       {'proxy':'owned','catalog_digest':'a'*64,'url':'forbidden'}):
            with self.assertRaises(GuardError):
                validate_message(dict(op='agent',profile=PROFILE,ready=False,session=None,remaining=0,
                                      reporting=True,protection=True,pause_remaining=0,strict=strict))

    def test_dead_agent_retires_gate_and_preserves_accounting(self):
        self.report()
        lane=self.strict.sessions[PROFILE]
        lane.guard.allowed=3;lane.guard.bytes_sent=7;lane.guard.bytes_received=9
        lane.seen-=7
        self.strict.tick()
        self.assertEqual(self.strict.sessions,{})
        self.assertEqual(self.parent.status()['strict_allowed'],3)
        self.assertEqual(self.parent.status()['strict_bytes'],16)
        self.assertEqual(lane.gate.fileno(),-1)

    def test_external_baseline_is_an_enum_not_provider_configuration(self):
        reply = self.report(baseline='external_pac')
        self.assertEqual(reply['strict']['baseline'],'external_pac')
        for fields in ({'baseline':'provider'}, {'baseline':{}},
                       {'baseline':'external_pac','pac':'function FindProxyForURL(){}'}):
            with self.assertRaises(GuardError):
                self.report(**fields)

    def test_close_isolated_to_selected_chrome_agent(self):
        other = 'e' * 32
        self.report();self.report(profile=other)
        self.wait(lambda:all(s.guard.mode=='active' for s in self.strict.sessions.values()))
        first = self.strict.sessions[PROFILE].guard
        second = self.strict.sessions[other].guard
        left,right = socket.socketpair()
        try:
            second.connections.add(left)
            self.parent.chrome.command(PROFILE,'block_sites')
            self.assertEqual(first.mode,'locked')
            self.assertEqual(self.report()['access'],'block')
            self.assertEqual(self.report(profile=other)['access'],'allow')
            self.assertNotEqual(left.fileno(),-1,'Close drained another profile tunnel')
            self.assertEqual(self.parent.mode,'locked','Optional browser was activated')
        finally:
            second.connections.discard(left);left.close();right.close()

    def test_suspend_gap_drains_tunnels_until_fresh_qualification(self):
        self.report()
        self.wait(lambda:self.strict.sessions[PROFILE].guard.mode=='active')
        session = self.strict.sessions[PROFILE]
        left,right = socket.socketpair()
        try:
            session.guard.connections.add(left)
            self.release.clear()
            session.attempt-=6
            self.strict.last_tick=(time.monotonic()-11,time.time()-11)
            self.strict.tick()
            self.assertEqual(left.fileno(),-1,'Suspend retained a previously admitted tunnel')
            self.assertEqual(self.report()['access'],'block')
            self.release.set()
            self.wait(lambda:session.guard.mode=='active')
            self.assertEqual(self.report()['access'],'allow')
        finally:right.close()

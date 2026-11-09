import json
import unittest

from mac_guard.chrome_events import validate_message
from mac_guard.chrome_control import ChromeControl
from mac_guard.policy import GuardError

PROFILE, SESSION, EVENT = 'a'*32, 'b'*32, 'c'*32


class ChromeControlTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.control = ChromeControl(clock=lambda: self.now)

    def agent(self, **values):
        message = dict(op='agent', profile=PROFILE, ready=True, session=SESSION,
                       remaining=60, reporting=True, protection=True, pause_remaining=0)
        message.update(values)
        self.control.receive(validate_message(message))

    def http(self, **values):
        message = dict(op='http', profile=PROFILE, session=SESSION, event=EVENT,
                       host='fixture.example.org', method='GET', status=200,
                       mime='text/html', duration_ms=14)
        message.update(values)
        self.control.receive(validate_message(message))

    def test_only_prepared_session_receives_http_and_commands_expire(self):
        with self.assertRaises(GuardError): self.http()
        with self.assertRaises(GuardError): self.control.command(PROFILE, 'start')
        self.agent()
        self.control.command(PROFILE, 'start')
        self.assertEqual(self.control.reply(PROFILE)['command']['session'], SESSION)
        self.now = 6
        self.assertNotIn('command', self.control.reply(PROFILE))
        self.now = 7
        self.assertEqual(self.control.snapshot()['agents'], [])

    def test_preview_is_solicited_bounded_and_not_in_event_journal(self):
        self.agent();self.http()
        preview=dict(op='preview', profile=PROFILE, session=SESSION, event=EVENT, command='d'*32, text='fixture content')
        with self.assertRaises(GuardError): self.control.receive(validate_message(preview))
        self.control.command(PROFILE, 'preview', EVENT)
        preview['command']=self.control.reply(PROFILE)['command']['id']
        self.control.receive(validate_message(preview))
        snapshot=self.control.snapshot()
        self.assertEqual(snapshot['preview']['text'], 'fixture content')
        self.assertNotIn('fixture content',json.dumps(snapshot['events']))
        self.now=10;self.agent()
        self.now=16
        self.assertIsNone(self.control.snapshot()['preview'])
        with self.assertRaises(GuardError): validate_message(dict(preview,text='x'*1025))

    def test_stop_revoke_navigation_and_deadline_erase_data(self):
        self.agent();self.http()
        self.control.receive(validate_message(dict(op='reset',profile=PROFILE,session=SESSION)))
        self.assertEqual(self.control.snapshot()['events'],[])
        self.http();self.control.command(PROFILE,'stop')
        self.assertEqual(self.control.snapshot()['events'],[])
        with self.assertRaises(GuardError):self.http()
        self.agent(ready=False,session=None,remaining=0)
        with self.assertRaises(GuardError): self.http()
        self.assertEqual(self.control.snapshot()['events'],[])
        self.agent();self.http();self.now=61
        self.assertEqual(self.control.snapshot()['events'],[])

    def test_rejects_header_url_route_and_unsolicited_body_fields(self):
        self.agent()
        message=dict(op='http',profile=PROFILE,session=SESSION,event=EVENT,host='fixture.example.org',method='GET',status=200,mime='text/html',duration_ms=1)
        for key in ('url','headers','cookies','body','route','command'):
            with self.assertRaises(GuardError):validate_message(dict(message,**{key:'forbidden'}))
        with self.assertRaises(GuardError):self.control.command(PROFILE,'activate')
        with self.assertRaises(GuardError):self.control.command(PROFILE,'preview',EVENT)

    def test_profiles_and_responses_are_isolated_and_bounded(self):
        self.agent()
        for index in range(105):self.http(event=f'{index:032x}')
        self.assertEqual(len(self.control.snapshot()['events']),100)
        self.control.command(PROFILE,'clear')
        self.assertEqual(self.control.snapshot()['events'],[])
        self.agent(ready=False,session=None,remaining=0)
        self.control.command(PROFILE,'pause_protection')
        command=self.control.reply(PROFILE)['command']
        self.assertEqual(command['action'],'pause_protection')
        self.control.receive(validate_message(dict(op='result',profile=PROFILE,command=command['id'],success=True)))
        self.assertNotIn('command',self.control.reply(PROFILE))
        for index in range(9):
            self.control.receive(validate_message(dict(op='agent',profile=f'{index:032x}',ready=False,session=None,remaining=0,reporting=True,protection=True,pause_remaining=0)))
        self.assertEqual(len(self.control.snapshot()['agents']),8)

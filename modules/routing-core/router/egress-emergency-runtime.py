"""Router-only lifecycle adapter for serial emergency egress transitions."""
from pathlib import Path
import copy
import hashlib
import json
import os
import runpy
import socket
import subprocess
import tempfile
import time

BASE = Path('/opt/etc/ghostroute-egress-emergency')
LIVE = Path('/opt/etc/sing-box/config.json')
PYTHON = '/opt/bin/python3'
CURL = '/opt/bin/curl'
QUALIFICATION_VERSION = 2

def atomic(path, data):
    raw = data if isinstance(data, bytes) else (json.dumps(data, sort_keys=True)+'\n').encode()
    temp = path.with_name(path.name+'.next')
    with temp.open('wb') as stream:
        os.fchmod(stream.fileno(),0o600); stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temp, path)
    directory=os.open(str(path.parent),os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)

def http_check(port, url, allowed, method='GET'):
    """Check the application response, not just an edge trace or TLS handshake."""
    args=[CURL,'-4','-sS','--proxy','socks5h://127.0.0.1:'+str(port),'--connect-timeout','4','--max-time','12','--max-filesize','2097152','-w','\n%{http_code}',url]
    if method=='POST': args += ['-H','Content-Type: application/json','--data','{}']
    response=subprocess.run(args,capture_output=True,timeout=15)
    body,_,code=response.stdout.rpartition(b'\n')
    blocked=any(value in body.lower() for value in [b'unsupported_country',b'unsupported region',b'cf-chl-',b'just a moment'])
    return {'ok':response.returncode==0 and code.decode() in allowed and (bool(body) or code==b'302') and not blocked,
            'exit':response.returncode,'http':code.decode() if len(code)==3 else 'unknown','blocked_response':blocked}

def identity(outbound): return {k:v for k,v in outbound.items() if k != 'tag'}

def candidate(source, profiles, role):
    result = copy.deepcopy(source)
    changed = []
    for i, outbound in enumerate(source['outbounds']):
        if identity(outbound) in profiles.values():
            result['outbounds'][i] = dict(profiles[role], tag=outbound['tag'])
            changed.append(outbound['tag'])
    if not {'reality-out','sensitive-out'} <= set(changed):
        raise ValueError('Unreviewed egress configuration')
    return result

class Runtime:
    def __init__(self, fd):
        self.fd = fd
        self.profiles = json.loads((BASE/'profiles.json').read_text())
        self.helpers = runpy.run_path(str(BASE/'application-probes.py'))

    def command(self, args, timeout=75):
        env = dict(os.environ, GR_EGRESS_LOCK_FD=str(self.fd))
        env.pop('GR_EGRESS_GUARD_WRAPPED', None)
        result = subprocess.run(args, env=env, pass_fds=(self.fd,), capture_output=True, timeout=timeout)
        if result.returncode:
            (BASE/'operation-error.private.log').write_bytes(result.stdout+result.stderr)
            for name in ['policy.log','watch.log','operation-error.private.json']:
                path=Path('/tmp/ghostroute-anytls')/name
                if path.exists():(BASE/('failed-anyt-'+name)).write_bytes(path.read_bytes())
            raise RuntimeError('Runtime operation failed')
        return result.stdout

    def init(self, action):
        return self.command(['/bin/sh','-c','. /jffs/scripts/ghostroute-runtime.env; "${GHOSTROUTE_SINGBOX_INIT:-/opt/etc/init.d/S99sing-box}" '+action])

    def lane(self, name, action):
        script = {'anytls':'channel-anytls.py','snell':'channel-snell.py','amn':'channel-amn.py'}[name]
        return self.command([PYTHON, '/opt/etc/ghostroute-'+name+'/'+script, action])

    def validate(self, config):
        with tempfile.TemporaryDirectory(prefix='gr-egress-check-', dir='/tmp') as folder:
            path = Path(folder)/'config.json'; atomic(path, config)
            self.command(['/opt/bin/sing-box','check','-c',str(path)], 30)

    def snapshot(self):
        # Fail before stopping anything if the source was changed outside this controller.
        source = json.loads(LIVE.read_text())
        candidate(source, self.profiles, 'normal')
        self.validate(candidate(source, self.profiles, 'emergency'))
        return {'anytls':(Path('/opt/etc/ghostroute-anytls')/'enabled').exists(),
                'snell':json.loads(self.lane('snell','status'))['watch_running'],
                'amn':json.loads(self.lane('amn','status'))['engine_running']}

    def stop(self):
        self.lane('snell','stop'); self.lane('anytls','stop'); self.lane('amn','stop'); self.init('stop')
        self.assert_quiet()

    def assert_quiet(self):
        owned = {'sing-box','sing-box-atls','sing-box-snell','sing-box-amn','gr-emergency-probe'}
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit(): continue
            try:
                argv = (proc/'cmdline').read_bytes().split(b'\0')
                name = Path(os.fsdecode(argv[0])).name
                if name in owned or name.startswith('gr-tg-probe'):
                    raise RuntimeError('An egress process remains active')
            except (FileNotFoundError, ProcessLookupError, PermissionError): pass

    def kill_probe(self):
        marker = BASE/'probe.pid'
        # A crash can happen between Popen and recording probe.pid. Only this
        # exact private executable is ours; do not kill unrelated diagnostics.
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit(): continue
            try:
                argv = (proc/'cmdline').read_bytes().split(b'\0')
                if argv[0] == str(BASE/'gr-emergency-probe').encode():
                    pid=int(proc.name)
                    os.kill(pid,15)
                    for _ in range(50):
                        try:
                            if not (proc/'cmdline').read_bytes(): break
                        except FileNotFoundError: break
                        time.sleep(.1)
                    else: raise RuntimeError('Diagnostic engine did not stop')
            except (FileNotFoundError,ProcessLookupError,PermissionError): pass
        marker.unlink(missing_ok=True)

    def probe(self, port):
        from concurrent.futures import ThreadPoolExecutor
        targets = json.loads((BASE/'targets.json').read_text())
        with ThreadPoolExecutor(max_workers=5) as pool:
            native = list(pool.map(lambda t:self.helpers['native_probe'](port,t,6),targets))
        urls = ['https://www.google.com/generate_204','https://chatgpt.com/cdn-cgi/trace','https://api.ipify.org/']
        codes = []
        failures = []
        for url in urls:
            p = subprocess.run(['/opt/bin/curl','-4','-sS','--proxy','socks5h://127.0.0.1:'+str(port),'--connect-timeout','4','--max-time','8','--max-filesize','2097152','-o','/dev/null','-w','%{http_code}',url],capture_output=True,timeout=10)
            codes.append(p.returncode == 0 and p.stdout[:1] in (b'2',b'3'))
            failures.append({'exit':p.returncode,'http':p.stdout.decode() if len(p.stdout)==3 else 'unknown'})
        passed = sum(r['ok'] for r in native)
        return {'healthy':sum(codes)>=2 and passed>=4,'down':not any(codes) and passed==0,'native_passed':passed,'http_passed':sum(codes),'native_errors':sorted(set(r.get('error','') for r in native if not r['ok'])),'http_results':failures}

    def health(self):
        config = json.loads(LIVE.read_text())
        port = next(i['listen_port'] for i in config['inbounds'] if i['tag']=='dnscrypt-socks-in')
        try:
            with socket.create_connection(('127.0.0.1',port),timeout=2): pass
        except OSError: return {'healthy':False,'down':False,'local_ok':False}
        result = self.probe(port)
        if result['down']:
            wan = subprocess.run(['/opt/bin/curl','-4','-fsS','--noproxy','*','--connect-timeout','4','--max-time','8','https://api.ipify.org/'],capture_output=True,timeout=10)
            result['local_ok'] = wan.returncode==0 and bool(wan.stdout.strip())
        else: result['local_ok'] = True
        return result

    def active_role(self):
        current=next(o for o in json.loads(LIVE.read_text())['outbounds'] if o['tag']=='reality-out')
        return next((role for role,profile in self.profiles.items() if identity(current)==profile),None)

    def qualify(self, role):
        self.assert_quiet()
        source = candidate(json.loads(LIVE.read_text()),self.profiles,role)
        reservation = socket.socket(); reservation.bind(('127.0.0.1',0)); port=reservation.getsockname()[1]; reservation.close()
        config = {'log':{'level':'debug','timestamp':True},'dns':source['dns'],'inbounds':[{'type':'socks','tag':'emergency-probe','listen':'127.0.0.1','listen_port':port}],
                  'outbounds':source['outbounds'],'route':{'default_domain_resolver':'cover-dns-server','final':'reality-out'}}
        self.validate(config); atomic(BASE/'probe.json',config)
        with (BASE/'probe.private.log').open('wb') as log:
            process = subprocess.Popen([str(BASE/'gr-emergency-probe'),'run','-c',str(BASE/'probe.json')],stdout=log,stderr=log,close_fds=True)
        atomic(BASE/'probe.pid',str(process.pid).encode())
        try:
            for _ in range(75):
                if process.poll() is not None: raise RuntimeError('Diagnostic engine exited before readiness')
                try:
                    with socket.create_connection(('127.0.0.1',port),timeout=.2): break
                except OSError: time.sleep(.2)
            else: raise RuntimeError('Diagnostic listener did not become ready')
            result = self.probe(port)
            from concurrent.futures import ThreadPoolExecutor
            def canary(row):
                url, allowed = row
                response = subprocess.run(['/opt/bin/curl','-4','-sS','--proxy','socks5h://127.0.0.1:'+str(port),'--connect-timeout','4','--max-time','8','--max-filesize','2097152','-o','/dev/null','-w','%{http_code}',url],capture_output=True,timeout=10)
                return response.returncode==0 and any(response.stdout.decode().startswith(prefix) for prefix in allowed)
            with ThreadPoolExecutor(max_workers=6) as pool:
                applications = list(pool.map(canary,json.loads((BASE/'canaries.json').read_text())))
            # Unauthenticated expected errors prove transport only. Real-client
            # logged-in streaming acceptance remains a separate operator check.
            sensitive={name:http_check(port,url,codes,method) for name,url,codes,method in [
                ('application','https://chatgpt.com/',['200'],'GET'),
                ('session','https://chatgpt.com/backend-api/wham/usage',['401'],'GET'),
                ('responses','https://api.openai.com/v1/responses',['401'],'POST'),
                ('login','https://auth.openai.com/',['200','302'],'GET')]}
            evidence=dict(result,role=role,qualification_version=QUALIFICATION_VERSION,canaries_passed=sum(applications),canaries_total=len(applications),sensitive_transport=sensitive)
            atomic(BASE/'qualification.json',evidence)
            atomic(BASE/('qualification-'+role+'.json'),evidence)
            ok, body = self.helpers['transfer'](port,'https://api.ipify.org/',6)
            wan = subprocess.run(['nvram','get','wan0_ipaddr'],capture_output=True,text=True,timeout=5).stdout.strip()
            import ipaddress
            exit_ip = str(ipaddress.IPv4Address(body.decode().strip())) if ok else ''
            return result['healthy'] and bool(applications) and all(applications) and all(row['ok'] for row in sensitive.values()) and bool(exit_ip) and exit_ip!=wan
        finally:
            process.terminate()
            try: process.wait(timeout=8)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            (BASE/'probe.pid').unlink(missing_ok=True); (BASE/'probe.json').unlink(missing_ok=True)

    def install(self, role):
        config = candidate(json.loads(LIVE.read_text()),self.profiles,role)
        self.validate(config); atomic(LIVE,config)
        amn = Path('/opt/etc/ghostroute-amn')
        namespace = runpy.run_path(str(BASE/'channel-amn-policy.py'))
        projected = namespace['project'](config,json.loads((amn/'settings.json').read_text()))
        atomic(amn/'policy.json',projected)
        atomic(amn/'policy.source.sha256',(hashlib.sha256(LIVE.read_bytes()).hexdigest()+'\n').encode())

    def start(self, lanes, require_healthy=True):
        self.init('start')
        for _ in range(3):
            if self.health()['healthy']:break
            time.sleep(2)
        else:
            if require_healthy:raise RuntimeError('Selected main egress did not become healthy')
            # Both exits may be down. Restore the former local data plane and
            # its direct traffic without calling an unavailable exit healthy.
            config=json.loads(LIVE.read_text())
            port=next(i['listen_port'] for i in config['inbounds'] if i['tag']=='dnscrypt-socks-in')
            with socket.create_connection(('127.0.0.1',port),timeout=2):pass
        if lanes['anytls']: self.lane('anytls','reconcile')
        if lanes['snell']: self.lane('snell','start')
        if lanes['amn']: self.lane('amn','start')

    def credentials(self):
        return {name:hashlib.sha256(Path('/opt/etc/ghostroute-'+name+'/settings.json').read_bytes()).hexdigest() for name in ['anytls','snell','amn']}

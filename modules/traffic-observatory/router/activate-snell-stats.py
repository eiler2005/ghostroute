import hashlib, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time

BASE=pathlib.Path('/opt/etc/ghostroute-snell')
STAGE=pathlib.Path('/tmp/ghostroute-channel-accounting-stage')
BACKUP=pathlib.Path('/opt/etc/ghostroute-observability/rollback-snell')
FILES=('channel-snell-policy.py','channel-snell.py')
OBS='observability.json'
def replace(path,data,mode=0o700):
    fd,name=tempfile.mkstemp(prefix='.channel-counter-',dir=path.parent)
    try:
        os.fchmod(fd,mode)
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
def command(action):
    return subprocess.run(['/opt/bin/python3',str(BASE/'channel-snell.py'),action],check=True,capture_output=True,timeout=45)
def ready():
    for _ in range(50):
        try:
            state=json.loads(subprocess.check_output(['/opt/bin/python3',str(BASE/'channel-snell.py'),'status'],timeout=10))
            if state.get('watch_running') and state.get('recent_policy_check'):return
        except (OSError,ValueError,subprocess.SubprocessError):pass
        time.sleep(.2)
    raise RuntimeError('Snell watcher not ready')
def restore():
    if not BACKUP.is_dir():raise RuntimeError('Missing rollback')
    command('stop')
    for name in FILES:replace(BASE/name,(BACKUP/name).read_bytes(),(BACKUP/name).stat().st_mode & 0o777)
    if (BACKUP/OBS).exists():replace(BASE/OBS,(BACKUP/OBS).read_bytes(),0o600)
    else:(BASE/OBS).unlink(missing_ok=True)
    command('start');ready()
if sys.argv[1:] == ['rollback']:
    restore();print('Snell prior controller and policy restored');sys.exit(0)
if sys.argv[1:] != ['enable']:raise RuntimeError('Invalid action')
ready()
before=hashlib.sha256((BASE/'settings.json').read_bytes()).hexdigest()
if BACKUP.exists():
    if any((BASE/name).read_bytes()!=(BACKUP/name).read_bytes() for name in FILES):raise RuntimeError('Prior controller was not restored')
    if (BASE/OBS).exists() != (BACKUP/OBS).exists():raise RuntimeError('Prior observability state was not restored')
    if (BASE/OBS).exists() and (BASE/OBS).read_bytes()!=(BACKUP/OBS).read_bytes():raise RuntimeError('Prior observability configuration differs')
else:
    BACKUP.mkdir(mode=0o700)
    for name in FILES:shutil.copy2(BASE/name,BACKUP/name)
    if (BASE/OBS).exists():shutil.copy2(BASE/OBS,BACKUP/OBS)
try:
    command('stop')
    for name in FILES:replace(BASE/name,(STAGE/name).read_bytes(),(BASE/name).stat().st_mode & 0o777)
    port=json.loads((STAGE/'plan.json').read_text())['Snell']
    replace(BASE/OBS,json.dumps({'stats_listen':'127.0.0.1:'+str(port)}).encode(),0o600)
    command('start');ready()
    if hashlib.sha256((BASE/'settings.json').read_bytes()).hexdigest()!=before:raise RuntimeError('Snell settings changed')
    sampled=False
    for _ in range(4):
        try:
            with socket.create_connection(('127.0.0.1',port),timeout=1):pass
            subprocess.run(['/opt/libexec/ghostroute-channel-stats','127.0.0.1:'+str(port)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=12)
            sampled=True;break
        except (OSError,subprocess.SubprocessError):time.sleep(.5)
    if not sampled:raise RuntimeError('Snell statistics API is not ready')
except BaseException:
    restore();raise
print('Snell isolated statistics active; profile settings unchanged')

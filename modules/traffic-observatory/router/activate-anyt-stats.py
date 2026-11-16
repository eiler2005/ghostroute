import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile

BASE=pathlib.Path('/opt/etc/ghostroute-anytls')
STAGE=pathlib.Path('/tmp/ghostroute-channel-accounting-stage')
BACKUP=pathlib.Path('/opt/etc/ghostroute-observability/rollback-anyt')
FILES=('channel-anytls-policy.py','channel-anytls.py')
OBS='observability.json'
def replace(path, data, mode=0o700):
    fd,name=tempfile.mkstemp(prefix='.channel-counter-', dir=path.parent)
    try:
        os.fchmod(fd,mode)
        with os.fdopen(fd,'wb') as f: f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
def restore():
    if not BACKUP.is_dir(): raise RuntimeError('Missing rollback')
    for name in FILES: replace(BASE/name,(BACKUP/name).read_bytes(),(BACKUP/name).stat().st_mode & 0o777)
    if (BACKUP/OBS).exists(): replace(BASE/OBS,(BACKUP/OBS).read_bytes(),0o600)
    else: (BASE/OBS).unlink(missing_ok=True)
    subprocess.run(['/opt/bin/python3',str(BASE/'channel-anytls.py'),'reconcile'],check=True,capture_output=True,timeout=90)
if sys.argv[1:] == ['rollback']:
    restore(); print('AnyTLS prior controller and policy restored');sys.exit(0)
if sys.argv[1:] != ['enable'] or BACKUP.exists(): raise RuntimeError('Invalid action or existing backup')
before=hashlib.sha256((BASE/'settings.json').read_bytes()).hexdigest()
BACKUP.mkdir(mode=0o700)
for name in FILES:
    shutil.copy2(BASE/name,BACKUP/name)
if (BASE/OBS).exists(): shutil.copy2(BASE/OBS,BACKUP/OBS)
try:
    for name in FILES: replace(BASE/name,(STAGE/name).read_bytes(),(BASE/name).stat().st_mode & 0o777)
    port=json.loads((STAGE/'plan.json').read_text())['anyT']
    replace(BASE/OBS,json.dumps({'stats_listen':'127.0.0.1:'+str(port)}).encode(),0o600)
    subprocess.run(['/opt/bin/python3',str(BASE/'channel-anytls.py'),'reconcile'],check=True,capture_output=True,timeout=90)
    state=json.loads(subprocess.check_output(['/opt/bin/python3',str(BASE/'channel-anytls.py'),'status'],timeout=20))
    if not state.get('policy_running') or not state.get('watch_running') or not state.get('source_current'):
        raise RuntimeError('AnyTLS ownership or policy check failed')
    if hashlib.sha256((BASE/'settings.json').read_bytes()).hexdigest()!=before:
        raise RuntimeError('Protected settings changed')
    subprocess.run(['/opt/libexec/ghostroute-channel-stats','127.0.0.1:'+str(port)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
except BaseException:
    restore(); raise
print('AnyTLS isolated statistics active; protected settings unchanged')

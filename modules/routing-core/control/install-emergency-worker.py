"""Executed on the router using private generated input; no outbound activation."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import shutil
import subprocess

os.umask(0o077)
base=Path('/opt/etc/ghostroute-egress-emergency')
assert not base.exists(),'Controller already installed; disarm and review before upgrade'
live=json.loads(Path('/opt/etc/sing-box/config.json').read_text())
normal=json.loads(FILES['profiles.json'])['normal']
assert next({k:v for k,v in o.items() if k!='tag'} for o in live['outbounds'] if o['tag']=='reality-out')==normal
environment=subprocess.check_output(['/bin/sh','-c','. /jffs/scripts/ghostroute-runtime.env; printf "%s\\n" "${GHOSTROUTE_SINGBOX_INIT:-/opt/etc/init.d/S99sing-box}" "${GHOSTROUTE_SINGBOX_WATCHDOG:-/jffs/scripts/singbox-watchdog.sh}"'],text=True).splitlines()
supervisor=Path('/jffs/scripts/ghostroute-runtime-supervisor.sh')
if not supervisor.exists():supervisor=Path('/jffs/scripts/ghostroute-runtime-supervisor')
paths={'channel-anytls.py':Path('/opt/etc/ghostroute-anytls/channel-anytls.py'),'channel-snell.py':Path('/opt/etc/ghostroute-snell/channel-snell.py'),'channel-amn.py':Path('/opt/etc/ghostroute-amn/channel-amn.py'),'ghostroute-runtime-supervisor':supervisor}
for name,path in paths.items():
    assert path.read_text().replace('\r\n','\n') in [BASELINE[name].replace('\r\n','\n'),UPDATES[name].replace('\r\n','\n')],'Runtime source drift: '+name
backup=Path('/opt/var/backups/ghostroute')/('emergency-install-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(parents=True,mode=0o700)
originals={str(path):path.read_bytes() for path in [*paths.values(),*map(Path,environment)]}
for i,(path,data) in enumerate(originals.items()):(backup/(str(i)+'.source')).write_bytes(data)
(backup/'manifest.json').write_text(json.dumps(list(originals)))
shutil.copy2('/opt/etc/sing-box/config.json',backup/'router-config.json')
base.mkdir(mode=0o700)
try:
    for name,content in FILES.items():
        if name=='guard.py':continue
        (base/name).write_text(content);(base/name).chmod(0o600)
    shutil.copy2('/opt/bin/sing-box',base/'gr-emergency-probe');(base/'gr-emergency-probe').chmod(0o700)
    for name,path in paths.items():
        mode=path.stat().st_mode&0o777;path.write_text(UPDATES[name]);path.chmod(mode)
    wrapper='if [ -f /opt/etc/ghostroute-egress-emergency/guard.py ] && [ "${GR_EGRESS_GUARD_WRAPPED:-0}" != 1 ]; then\n exec /opt/bin/python3 /opt/etc/ghostroute-egress-emergency/guard.py -- /bin/sh "$0" "$@"\nfi\n'
    for value in environment:
        path=Path(value);text=path.read_text();first,rest=text.split('\n',1)
        assert first.startswith('#!')
        if '/opt/etc/ghostroute-egress-emergency/guard.py' in text:continue
        mode=path.stat().st_mode&0o777;path.write_text(first+'\n'+wrapper+rest);path.chmod(mode)
    # Guard is installed last. The monitor stays disabled until a successful drill.
    (base/'state.json').write_text(json.dumps({'selected':'normal','latched':False}))
    (base/'guard.py').write_text(FILES['guard.py']);(base/'guard.py').chmod(0o600)
    print(json.dumps({'installed':True,'enabled':False,'active_profile':'normal','profiles_preserved':True}))
except Exception:
    for path,data in originals.items():Path(path).write_bytes(data)
    shutil.rmtree(base)
    raise

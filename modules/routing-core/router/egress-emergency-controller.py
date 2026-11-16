#!/opt/bin/python3
"""Latched, thirty-minute emergency egress controller. Reserve stays cold."""
from pathlib import Path
import fcntl
import hashlib
import json
import os
import runpy
import sys
import subprocess
import time

BASE=Path('/opt/etc/ghostroute-egress-emergency')
LOCK=Path('/tmp/ghostroute-egress-emergency.lock')
WINDOW=Path('/tmp/ghostroute-egress-emergency-window.json')
QUALIFICATION_VERSION=2

def read(path, fallback):
    return json.loads(path.read_text()) if path.exists() else fallback

def acquire(lock, wait=False, timeout=60):
    deadline=time.monotonic()+timeout
    while True:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            if not wait:return False
            if time.monotonic()>=deadline:raise TimeoutError('Egress recovery lease remains busy')
            time.sleep(.2)

def proof_current():
    proof=read(BASE/'drill-result.json',{})
    return bool(proof.get('last_transition_ok')) and proof.get('qualification_version')==QUALIFICATION_VERSION and proof.get('profiles_digest')==hashlib.sha256((BASE/'profiles.json').read_bytes()).hexdigest()

def transition(runtime, role, state, atomic):
    marker=BASE/'transition.json'
    lanes=runtime.snapshot(); credentials=runtime.credentials()
    previous=state.get('selected','normal')
    def phase(name):atomic(marker,{'previous':previous,'lanes':lanes,'phase':name})
    phase('prepared')
    try:
        phase('stop')
        runtime.stop()
        phase('qualification')
        if not runtime.qualify(role): raise RuntimeError('Candidate application probes failed')
        phase('activation')
        runtime.install(role); runtime.start(lanes)
        phase('postcheck')
        if not runtime.health()['healthy']: raise RuntimeError('Post-switch application probes failed')
        if runtime.credentials()!=credentials: raise RuntimeError('Client settings changed')
        state={'selected':role,'latched':role=='emergency','last_transition_ok':True}
        atomic(BASE/'state.json',state); marker.unlink()
        return state
    except Exception as error:
        failed_phase=read(marker,{}).get('phase','unknown')
        # Stop the rejected profile before restoring the previous one.
        runtime.kill_probe(); runtime.stop(); runtime.install(previous); runtime.start(lanes,require_healthy=False)
        state.update(last_transition_ok=False,error='transition_failed',failed_phase=failed_phase,error_type=type(error).__name__)
        atomic(BASE/'state.json',state); marker.unlink()
        return state

def recover(runtime, atomic):
    marker=BASE/'transition.json'
    if marker.exists():
        info=read(marker,{})
        runtime.kill_probe(); runtime.stop(); runtime.install(info['previous']); runtime.start(info['lanes'],require_healthy=False)
        atomic(BASE/'state.json',{'selected':info['previous'],'latched':info['previous']=='emergency','last_transition_ok':False,'error':'interrupted_transition'})
        marker.unlink()

def main():
    os.umask(0o077)
    action=sys.argv[1] if len(sys.argv)>1 else 'status'
    if action=='status':
        state=read(BASE/'state.json',{'selected':'normal'});window=read(WINDOW,{})
        since=window.get('failure_since')
        print(json.dumps(dict(state,active_backend='backup_reality_emergency' if state['selected']=='emergency' else 'backup_reality',enabled=(BASE/'enabled').exists(),transition=(BASE/'transition.json').exists(),failure_age_seconds=max(0,int(time.monotonic()-since)) if since is not None else 0,health=read(BASE/'health.json',{}))))
        return
    with LOCK.open('a') as lock:
        try:
            if not acquire(lock,wait=action!='recover',timeout=10 if action=='run' else 60):return
        except TimeoutError:
            if action=='run':return
            raise
        os.environ['GR_EGRESS_LOCK_FD']=str(lock.fileno())
        module=runpy.run_path(str(BASE/'runtime.py')); atomic=module['atomic'];runtime=module['Runtime'](lock.fileno())
        recover(runtime,atomic)
        if action=='recover': return
        if action in ['enable','disable']:
            if action=='enable':
                if not proof_current():
                    raise ValueError('A successful serial qualification drill is required before enabling')
                if runtime.active_role() not in ['normal','emergency']: raise ValueError('Unknown active profile')
                atomic(BASE/'state.json',{'selected':runtime.active_role(),'latched':runtime.active_role()=='emergency'})
                atomic(BASE/'enabled',b'enabled\n')
                subprocess.run(['cru','d','EgressEmergency'],capture_output=True)
                subprocess.run(['cru','a','EgressEmergency','*/5 * * * * /opt/bin/python3 /opt/etc/ghostroute-egress-emergency/controller.py run'],check=True,capture_output=True)
            else:
                (BASE/'enabled').unlink(missing_ok=True)
                subprocess.run(['cru','d','EgressEmergency'],capture_output=True)
            WINDOW.unlink(missing_ok=True)
            return
        state=read(BASE/'state.json',{'selected':'normal','latched':False})
        if action=='drill':
            if state['selected']!='normal': raise ValueError('Drill requires the normal profile')
            state=transition(runtime,'emergency',state,atomic)
            if state.get('last_transition_ok'):
                state=transition(runtime,'normal',state,atomic)
            state['profiles_digest']=hashlib.sha256((BASE/'profiles.json').read_bytes()).hexdigest()
            state['qualification_version']=QUALIFICATION_VERSION
            atomic(BASE/'drill-result.json',state)
            if state.get('selected')!='normal' or not state.get('last_transition_ok'): raise RuntimeError('Drill failed')
            return
        if action in ['switch-emergency','switch-normal']:
            role='emergency' if action=='switch-emergency' else 'normal'
            if state['selected']!=role: state=transition(runtime,role,state,atomic)
            print(json.dumps(state))
            if state['selected']!=role: raise RuntimeError('Switch failed')
            return
        if action!='run': raise ValueError('Unknown action')
        if not (BASE/'enabled').exists(): return
        if not proof_current():
            atomic(BASE/'state.json',dict(state,error='qualification_stale'))
            (BASE/'enabled').unlink()
            return
        if runtime.active_role()!=state['selected']:
            atomic(BASE/'state.json',dict(state,error='external_config_change'))
            (BASE/'enabled').unlink()
            return
        health=runtime.health(); health['checked_at_unix']=int(time.time()); state['health']=health; atomic(BASE/'health.json',health)
        if state['selected']=='emergency': return  # Explicit manual return only.
        policy=runpy.run_path(str(BASE/'policy.py'))['observe']
        now=time.monotonic(); boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        window=policy(read(WINDOW,{}),now,boot,not health.get('down',False),health['local_ok'])
        atomic(WINDOW,window)
        if window['switch']:
            transition(runtime,'emergency',state,atomic)
            WINDOW.unlink(missing_ok=True)

if __name__=='__main__':
    try: main()
    except Exception:
        # Marker is intentionally retained on failed rollback: recovery owners
        # must not revive an unknown profile. The next cron retries recovery.
        print('Emergency egress operation failed; inspect private state',file=sys.stderr)
        raise SystemExit(1)

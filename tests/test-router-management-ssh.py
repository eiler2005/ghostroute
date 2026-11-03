import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    work=Path(tmp)
    binaries=work/'bin'; binaries.mkdir()
    state=work/'iptables.json'
    initial={'INPUT':[['-p','tcp','--dport','22022','-j','ACCEPT'],['-p','tcp','--dport','443','-j','ACCEPT']], 'OTHER':[['-j','ACCEPT']]}
    state.write_text(json.dumps(initial))
    stub=binaries/'iptables'
    stub.write_text('''#!/usr/bin/env python3
import json,os,sys
p=os.environ['TEST_IPTABLES_STATE']; d=json.load(open(p)); a=sys.argv[1:]; op=a.pop(0); chain=a.pop(0)
if op=='-S':
    if chain not in d: sys.exit(1)
    for rule in d[chain]: print('-A '+chain+' '+' '.join(rule))
elif op=='-N':
    if chain in d: sys.exit(1)
    d[chain]=[]
elif op=='-F':
    if chain not in d: sys.exit(1)
    d[chain]=[]
elif op=='-X':
    if chain not in d: sys.exit(1)
    del d[chain]
elif op=='-A': d[chain].append(a)
elif op=='-I': d[chain].insert(int(a.pop(0))-1,a)
elif op=='-D':
    if a not in d[chain]: sys.exit(1)
    d[chain].remove(a)
else: sys.exit(2)
with open(p,'w') as f: json.dump(d,f)
''')
    stub.chmod(0o755)
    nvram=binaries/'nvram'
    nvram.write_text('#!/bin/sh\ncase "$2" in sshd_port) echo "${TEST_SSH_PORT:-22022}" ;; sshd_enable) echo 1 ;; ipv6_service) echo disabled ;; esac\n')
    nvram.chmod(0o755)
    config=work/'policy.conf'
    env=dict(os.environ,PATH=str(binaries)+':'+os.environ['PATH'],TEST_IPTABLES_STATE=str(state),GHOSTROUTE_MANAGEMENT_SSH_CONFIG=str(config),GHOSTROUTE_MANAGEMENT_SSH_LOCK=str(work/'lock'))
    guard=ROOT/'modules/routing-core/router/router-management-ssh'
    def run(action,ok=True):
        p=subprocess.run(['sh',str(guard),action],env=env,capture_output=True,text=True)
        assert (p.returncode==0)==ok,(action,p.stdout,p.stderr)
        return json.loads(state.read_text())
    config.write_text("ENABLED=0\nALLOWED_SOURCES=''\n")
    assert run('apply')==initial
    config.write_text("ENABLED=1\nALLOWED_SOURCES='0.0.0.0/0'\n")
    assert run('apply',False)==initial
    config.write_text("ENABLED=1\nALLOWED_SOURCES='203.0.113.10/32 198.51.100.20/32'\n")
    first=run('apply')
    def evaluate(d,chain,source,interface,port):
        for rule in d[chain]:
            if '--dport' in rule and int(rule[rule.index('--dport')+1])!=port: continue
            if '-i' in rule and rule[rule.index('-i')+1]!=interface: continue
            if '-s' in rule and ipaddress.ip_address(source) not in ipaddress.ip_network(rule[rule.index('-s')+1]): continue
            target=rule[rule.index('-j')+1]
            if target in ['ACCEPT','DROP']: return target
            result=evaluate(d,target,source,interface,port)
            if result: return result
        return None
    assert evaluate(first,'INPUT','203.0.113.10','wan0',22022)=='ACCEPT'
    assert evaluate(first,'INPUT','198.51.100.20','wan0',22022)=='ACCEPT'
    assert evaluate(first,'INPUT','192.0.2.90','wan0',22022)=='DROP'
    assert evaluate(first,'INPUT','192.0.2.90','br0',22022)=='ACCEPT'
    assert evaluate(first,'INPUT','127.0.0.1','lo',22022)=='ACCEPT'
    assert evaluate(first,'INPUT','192.0.2.90','wan0',443)=='ACCEPT'
    second=run('apply')
    assert sum('GR_SSH_ADMIN_' in ' '.join(r) for r in second['INPUT'])==1
    assert second['OTHER']==initial['OTHER']
    env['TEST_SSH_PORT']='22023'
    third=run('apply')
    assert all('22022' not in r for r in third['INPUT'])
    assert evaluate(third,'INPUT','192.0.2.90','wan0',22023)=='DROP'
    disabled=run('disable')
    assert not any('GR_SSH_ADMIN_' in ' '.join(r) for r in disabled['INPUT'])
    assert 'ENABLED=0' in config.read_text()
    assert disabled['OTHER']==initial['OTHER']
print('management SSH: fail-closed policy validation, trusted sources, LAN, untrusted denial, service isolation, reapply, port change and rollback pass')

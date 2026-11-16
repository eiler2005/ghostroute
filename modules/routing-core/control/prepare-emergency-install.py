#!/usr/bin/env python3
"""Emit a private router installer; called only by the guarded CLI temp pipeline."""
from pathlib import Path
import json
import subprocess
import sys
import yaml

ROOT=Path(__file__).resolve().parents[3]
vault=yaml.safe_load(Path(sys.argv[1]).read_text())
def profile(prefix):
    get=lambda name,default=None:vault.get(prefix+name,default)
    transport=get('transport','tcp');flow=get('flow','' if transport=='grpc' else 'xtls-rprx-vision')
    assert transport in ('tcp','grpc')
    item={'type':'vless','server':get('server'),'server_port':int(get('server_port',443)),'uuid':get('uuid'),'packet_encoding':get('packet_encoding','xudp'),'tcp_fast_open':False,'tcp_keep_alive_interval':'30s','connect_timeout':'10s','multiplex':{'enabled':False},'tls':{'enabled':True,'server_name':get('server_name'),'utls':{'enabled':True,'fingerprint':get('utls_fingerprint','chrome')},'reality':{'enabled':True,'public_key':get('public_key'),'short_id':get('short_id')}}}
    assert all([item['server'],item['uuid'],get('server_name'),get('public_key')])
    if flow:item['flow']=flow
    if get('alpn',[]):item['tls']['alpn']=get('alpn')
    if transport=='grpc':
        assert not flow and get('grpc_service_name') and 'h2' in get('alpn',[])
        item['transport']={'type':'grpc','service_name':get('grpc_service_name')}
    return item
profiles={'normal':profile('vault_router_backup_reality_'),'emergency':profile('vault_router_backup_reality_emergency_')}
assert profiles['normal']!=profiles['emergency']
files={}
sources={'controller.py':'egress-emergency-controller.py','runtime.py':'egress-emergency-runtime.py','guard.py':'egress-emergency-guard.py','policy.py':'egress-emergency-policy.py','channel-amn-policy.py':'channel-amn-policy.py'}
for dest,name in sources.items():files[dest]=(ROOT/'modules/routing-core/router'/name).read_text()
files['application-probes.py']=(ROOT/'modules/ghostroute-health-monitor/router/telegram-egress-probe.py').read_text()
targets=[line.split() for line in (ROOT/'modules/ghostroute-health-monitor/config/telegram-native-targets.tsv').read_text().splitlines() if line.strip() and not line.startswith('#')]
files['targets.json']=json.dumps([(label,host,int(port)) for label,host,port in targets])
canaries=[line.split('\t') for line in (ROOT/'modules/ghostroute-health-monitor/config/managed-app-canaries.tsv').read_text().splitlines() if line.strip() and not line.startswith('#')]
files['canaries.json']=json.dumps([(url,codes.split(',')) for _,url,codes in canaries])
files['profiles.json']=json.dumps(profiles)
updates={};baseline={}
for name in ['channel-anytls.py','channel-snell.py','channel-amn.py','ghostroute-runtime-supervisor']:
    rel='modules/routing-core/router/'+name
    updates[name]=(ROOT/rel).read_text()
    baseline[name]=subprocess.check_output(['git','show','deba671:'+rel],cwd=ROOT,text=True)
worker=(ROOT/'modules/routing-core/control/install-emergency-worker.py').read_text()
print('FILES='+repr(files)+'\nUPDATES='+repr(updates)+'\nBASELINE='+repr(baseline)+'\n'+worker)

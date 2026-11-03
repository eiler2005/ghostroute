import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import yaml
from jinja2 import Environment, StrictUndefined

ROOT=Path(__file__).resolve().parents[1]
role=ROOT/'ansible/roles/router_management'
env=Environment(undefined=StrictUndefined)
env.filters['to_json']=json.dumps
env.filters['quote']=shlex.quote
env.filters['bool']=bool
env.filters['ternary']=lambda v,a,b:a if v else b
values={
 'vault_router_hermes_vps_ssh_host':'bastion.example.invalid',
 'vault_router_hermes_vps_ssh_port':22022,
 'vault_router_management_bastion_user':'jump_test',
 'vault_router_hermes_vps_ssh_key':'/example/keys/bastion',
 'vault_router_management_local_known_hosts_path':'/example/private/known_hosts',
 'ghostroute_router_remote_host':'Router.Example.INVALID',
 'ghostroute_router_remote_port':22023,
 'ghostroute_router_remote_user':'operator_test',
 'vault_router_management_operator_key_path':'/example/keys/router',
}
rendered=env.from_string((role/'templates/ssh_config.j2').read_text()).render(**values)
with tempfile.TemporaryDirectory() as tmp:
    config=Path(tmp)/'ssh_config'; config.write_text(rendered)
    for alias in ['ghostroute-router','ghostroute-hermes-jump']:
        p=subprocess.run(['ssh','-G','-F',str(config),alias],capture_output=True,text=True,check=True)
        options=dict(line.split(' ',1) for line in p.stdout.splitlines() if ' ' in line)
        assert options['forwardagent']=='no'
        assert options['stricthostkeychecking']=='true'
        assert options['identitiesonly']=='yes'
        assert options['batchmode']=='yes'
        assert options.get('controlpath','none')=='none'
        if alias=='ghostroute-router':
            assert options['hostname']=='router.example.invalid'
            assert options['proxyjump']=='ghostroute-hermes-jump'
            assert options['identityfile']=='/example/keys/router'
        else:
            assert options['identityfile']=='/example/keys/bastion'
    deploy=(ROOT/'deploy.sh').read_text()
    start=deploy.index('build_scp_opts() {'); end=deploy.index('\n}',start)+2
    script=Path(tmp)/'scp-options.sh'
    script.write_text('#!/bin/bash\nset -eu\n'+deploy[start:end]+'''\nSSH_OPTS=(-i /example/key -p 22023 -F /example/config -o ProxyJump=jump_test -o StrictHostKeyChecking=yes)
build_scp_opts
printf '%s\\n' "${SCP_OPTS[@]}"
''')
    result=subprocess.check_output(['bash',str(script)],text=True).splitlines()
    assert result==['-O','-i','/example/key','-P','22023','-F','/example/config','-o','ProxyJump=jump_test','-o','StrictHostKeyChecking=yes']
    backup_values=dict(values, vault_router_management_backup_enabled=True, vault_router_management_backup_ssh_port=22024, vps_ssh_host='backup.example.invalid')
    config.write_text(env.from_string((role/'templates/ssh_config.j2').read_text()).render(**backup_values))
    for alias,jump in [('ghostroute-router','ghostroute-hermes-jump'),('ghostroute-router-backup','ghostroute-primary-jump')]:
        p=subprocess.run(['ssh','-G','-F',str(config),alias],capture_output=True,text=True,check=True)
        opts=dict(line.split(' ',1) for line in p.stdout.splitlines() if ' ' in line)
        assert opts['proxyjump']==jump
        assert opts['identityfile']=='/example/keys/router'
        assert opts['stricthostkeychecking']=='true' and opts['forwardagent']=='no'
    p=subprocess.run(['ssh','-G','-F',str(config),'ghostroute-primary-jump'],capture_output=True,text=True,check=True)
    opts=dict(line.split(' ',1) for line in p.stdout.splitlines() if ' ' in line)
    assert opts['hostname']=='backup.example.invalid' and opts['identityfile']=='/example/keys/bastion'
    assert opts['port']=='22024'
tasks=yaml.safe_load((role/'tasks/bastion.yml').read_text())
keytask=next(t for t in tasks if t['name']=='Install restricted public key only')
key=env.from_string(keytask['ansible.builtin.copy']['content']).render(**values,vault_router_management_bastion_public_key='ssh-ed25519 EXAMPLEPUBLICKEY')
assert key.startswith('restrict,port-forwarding,permitopen="router.example.invalid:22023",command="/usr/sbin/nologin" ssh-ed25519 ')
assert '\\"' not in key
hardening=next(t for t in tasks if t['name']=='Require public keys for bastion-host SSH')['ansible.builtin.copy']['content']
assert 'PasswordAuthentication no' in hardening and 'AuthenticationMethods publickey' in hardening
env.filters['unique']=lambda items:list(dict.fromkeys(items))
for existing in [[],['existing_admin','ops@198.51.100.0/24']]:
    policy=env.from_string(hardening).render(**values,bastion_allowed_users={'stdout':'\n'.join(existing),'stdout_lines':existing})
    allow=[l for l in policy.splitlines() if l.startswith('AllowUsers ')]
    if existing:
        assert allow==['AllowUsers '+' '.join(existing+['jump_test'])]
    else:
        assert not allow, 'Do not turn an unrestricted admin policy into a single-account allow list'
scope=next(t for t in tasks if t['name']=='Restrict bastion account to the router SSH destination')['ansible.builtin.blockinfile']['block']
assert 'AllowTcpForwarding local' in scope and 'PermitListen none' in scope and 'ForceCommand /usr/sbin/nologin' in scope
for t in tasks:
    copy=t.get('ansible.builtin.copy',{})
    assert 'PRIVATE KEY' not in copy.get('content','')
    assert 'private_key' not in copy.get('dest','')
print('management access: real SSH profile parsing, strict host pins, distinct keys, no agent forwarding, restricted bastion and SCP transport pass')
for filename in ['26-router-management-access.yml','27-router-management-backup.yml']:
    plays=yaml.safe_load((ROOT/'ansible/playbooks'/filename).read_text())
    remote=[p for p in plays if p['hosts']!='localhost']
    assert all(p.get('vars',{}).get('ansible_host_key_checking') is True for p in remote)
inventory=yaml.safe_load((ROOT/'ansible/inventory/stealth.yml').read_text())
router=inventory['all']['children']['routers']['hosts']['router-home']
assert 'vault_router_management_ssh_enabled' in router['ansible_host_key_checking']
listener=env.from_string((role/'templates/backup_sshd_config.j2').read_text()).render(**values,vault_router_management_backup_ssh_port=22024)
directives={tokens[0]:tokens[1:] for line in listener.splitlines() if (tokens:=shlex.split(line,comments=True))}
for key,expected in {'Port':['22024'],'ListenAddress':['0.0.0.0'],'AllowUsers':['jump_test'],'PermitRootLogin':['no'],'PasswordAuthentication':['no'],'AuthenticationMethods':['publickey'],'MaxSessions':['0'],'AllowTcpForwarding':['local'],'AllowAgentForwarding':['no'],'PermitListen':['none'],'ForceCommand':['/usr/sbin/nologin'],'PermitOpen':['router.example.invalid:22023']}.items():
    assert directives[key]==expected
assert 'Include' not in directives, 'The backup listener must not inherit administrative account allowances'
backup_tasks=yaml.safe_load((role/'tasks/backup-listener.yml').read_text())
firewall=next(t['ansible.builtin.command']['argv'] for t in backup_tasks if t['name'].startswith('Allow only the dedicated'))
assert firewall[:6]==['ufw','allow','proto','tcp','from','0.0.0.0/0']
assert firewall[firewall.index('port')+1]=='{{ vault_router_management_backup_ssh_port | int }}'
assert not any('ufw reset' in str(t) or 'ufw disable' in str(t) for t in backup_tasks)
print('backup listener: dedicated port, restricted account only, no root/shell, pinned target, isolated firewall rule pass')

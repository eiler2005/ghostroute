#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ruby - "${PROJECT_ROOT}" <<'RUBY'
project_root = ARGV.fetch(0)

init_templates = [
  "ansible/roles/singbox_client/templates/S99singbox.j2",
  "ansible/roles/dnscrypt_proxy/templates/S09dnscrypt-proxy2.j2",
  "ansible/roles/channel_b_home_relay/templates/S99xray-channel-b-home.j2",
  "ansible/roles/channel_d_naiveproxy/templates/S99caddy-channel-d-naiveproxy.j2"
]

def fail!(message)
  warn "router init static test: #{message}"
  exit 1
end

init_templates.each do |relative_path|
  path = File.join(project_root, relative_path)
  src = File.read(path)

  fail!("#{relative_path} missing pid_is_live") unless src.include?("pid_is_live()")
  fail!("#{relative_path} missing zombie-state rejection") unless src.include?("*Z*) return 1 ;;")
  fail!("#{relative_path} must check process existence only inside pid_is_live") unless src.include?('kill -0 "$pid"')
  fail!("#{relative_path} start/status must use pid_is_live") unless src.include?('pid_is_live "$PID"')
  fail!("#{relative_path} must not trust raw pidfile kill -0") if src.match?(/kill -0 "\$\(cat "\$PIDFILE"/)
  fail!("#{relative_path} must not trust raw unquoted pidfile kill -0") if src.match?(/kill -0 \$\(cat "\$PIDFILE"/)
end

puts "router init static tests passed"
RUBY

#!/bin/bash
# Static render check for Hermes outer Caddy app web routes (no network, no VPS).
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Render with the same Jinja2 that Ansible uses (Ansible's interpreter), falling back to python3.
PYTHON=python3
if command -v ansible >/dev/null 2>&1; then
  ansible_python="$(head -1 "$(command -v ansible)" | sed -n 's/^#!//p' | awk '{print $1}')"
  [ -x "${ansible_python}" ] && PYTHON="${ansible_python}"
fi
"${PYTHON}" -c 'import jinja2' 2>/dev/null || { echo "hermes app web routes static: jinja2 unavailable" >&2; exit 1; }

"${PYTHON}" - "${PROJECT_ROOT}" <<'PY'
import sys
from pathlib import Path

import jinja2

root = Path(sys.argv[1])
template = jinja2.Environment(undefined=jinja2.StrictUndefined).from_string(
    (root / "ansible/roles/caddy_l4/templates/Caddyfile.j2").read_text(encoding="utf-8")
)
base = {
    "reality_server_names": ["cover.example.invalid"],
    "xray_reality_listen_port": 8443,
    "caddy_l4_web_sni_host": "digest.example.invalid",
    "caddy_l4_web_upstream": "127.0.0.1:8444",
}

without_extra = template.render(**base)
with_empty = template.render(**base, caddy_l4_extra_web_routes=[])
assert without_extra == with_empty, "an empty extra route list must not change the Caddyfile"
assert "@web tls sni digest.example.invalid" in without_extra

rendered = template.render(
    **base,
    caddy_l4_extra_web_routes=[
        {"name": "career_copilot", "sni_host": "career.example.invalid", "upstream": "127.0.0.1:8445"}
    ],
)
added = [line for line in rendered.splitlines() if line not in without_extra.splitlines()]
assert [line.strip() for line in added] == [
    "@career_copilot tls sni career.example.invalid",
    "route @career_copilot {",
    "proxy 127.0.0.1:8445",
], added
extra = rendered.index("@career_copilot tls sni")
assert rendered.index("@reality tls sni") < rendered.index("@web tls sni") < extra
assert extra < rendered.index("# Default:"), "extra routes must precede the Xray default route"

playbook = (root / "ansible/playbooks/13-hermes-app-web-route.yml").read_text(encoding="utf-8")
for required in ("CC_PUBLIC_HOST", "caddy_l4_extra_web_routes", "_cc_host != reality_server_names[0]", "Validate new Caddyfile inside the caddy-l4 image"):
    assert required in playbook, required
print("hermes app web routes static: OK")
PY

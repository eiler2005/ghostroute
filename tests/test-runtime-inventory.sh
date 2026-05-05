#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVENTORY="${PROJECT_ROOT}/configs/runtime-inventory.yml"

ruby -ryaml -rset - "${PROJECT_ROOT}" "${INVENTORY}" <<'RUBY'
project_root = ARGV.fetch(0)
inventory_path = ARGV.fetch(1)

def fail!(message)
  warn "runtime-inventory: #{message}"
  exit 1
end

data = YAML.load_file(inventory_path)
fail!("top-level document must be a mapping") unless data.is_a?(Hash)

%w[metadata components ports compatibility_claims upgrade_gates].each do |key|
  fail!("missing top-level #{key}") unless data.key?(key)
end

components = data["components"]
ports = data["ports"]
claims = data["compatibility_claims"]
gates = data["upgrade_gates"]

fail!("components must be a non-empty list") unless components.is_a?(Array) && !components.empty?
fail!("ports must be a non-empty list") unless ports.is_a?(Array) && !ports.empty?
fail!("compatibility_claims must be a list") unless claims.is_a?(Array)
fail!("upgrade_gates must be a list") unless gates.is_a?(Array)

component_required = %w[
  id component_name supplier type ecosystem origin package_names version_policy
  relationships runtime_checks compatibility_notes
]
version_policy_required = %w[
  proven_good minimum_required candidate known_problematic rollback_available
]
port_required = %w[
  id owner_component protocol bind_scope exposure source_var conflict_group
  iana_range runtime_check
]

component_ids = Set.new
components.each do |component|
  fail!("component entry must be a mapping") unless component.is_a?(Hash)
  component_required.each do |key|
    fail!("component #{component["id"] || "<unknown>"} missing #{key}") unless component.key?(key)
  end

  id = component["id"]
  fail!("component id must be non-empty") unless id.is_a?(String) && !id.empty?
  fail!("duplicate component id #{id}") unless component_ids.add?(id)

  fail!("component #{id} package_names must be a non-empty list") unless component["package_names"].is_a?(Array) && !component["package_names"].empty?
  fail!("component #{id} relationships must be a list") unless component["relationships"].is_a?(Array)
  fail!("component #{id} runtime_checks must be a non-empty list") unless component["runtime_checks"].is_a?(Array) && !component["runtime_checks"].empty?
  fail!("component #{id} compatibility_notes must be a list") unless component["compatibility_notes"].is_a?(Array)

  policy = component["version_policy"]
  fail!("component #{id} version_policy must be a mapping") unless policy.is_a?(Hash)
  version_policy_required.each do |key|
    fail!("component #{id} version_policy missing #{key}") unless policy.key?(key)
  end
end

known_var_sources = Set.new(Array(data.dig("metadata", "fixed_port_sources")))
source_files = []
source_files.concat(Dir[File.join(project_root, "ansible", "**", "*.yml")])
source_files.concat(Dir[File.join(project_root, "ansible", "**", "*.j2")])
source_files << File.join(project_root, ".env.example")
source_files << File.join(project_root, "modules", "shared", "lib", "router-health-common.sh")

source_files.each do |path|
  next unless File.file?(path)
  File.read(path).scan(/\b[A-Za-z_][A-Za-z0-9_]*\b/) do |match|
    known_var_sources << match
  end
end

allowed_iana_ranges = Set["system", "user", "dynamic-private"]
port_ids = Set.new
conflict_sources = Hash.new { |hash, key| hash[key] = Set.new }

ports.each do |port|
  fail!("port entry must be a mapping") unless port.is_a?(Hash)
  port_required.each do |key|
    fail!("port #{port["id"] || "<unknown>"} missing #{key}") unless port.key?(key)
  end

  id = port["id"]
  fail!("port id must be non-empty") unless id.is_a?(String) && !id.empty?
  fail!("duplicate port id #{id}") unless port_ids.add?(id)

  owner = port["owner_component"]
  fail!("port #{id} references unknown owner_component #{owner}") unless component_ids.include?(owner)

  protocols = port["protocol"].is_a?(Array) ? port["protocol"] : [port["protocol"]]
  fail!("port #{id} protocol must be tcp and/or udp") unless protocols.all? { |proto| %w[tcp udp].include?(proto) }

  source_var = port["source_var"]
  fail!("port #{id} source_var must be non-empty") unless source_var.is_a?(String) && !source_var.empty?
  fail!("port #{id} source_var #{source_var} is not known in Ansible/runtime vars") unless known_var_sources.include?(source_var)

  iana_range = port["iana_range"]
  fail!("port #{id} has invalid iana_range #{iana_range}") unless allowed_iana_ranges.include?(iana_range)

  conflict_group = port["conflict_group"]
  conflict_key = [conflict_group, protocols.sort.join("+")]
  fail!("port #{id} repeats source_var #{source_var} in conflict_group #{conflict_group}") if conflict_sources[conflict_key].include?(source_var)
  conflict_sources[conflict_key] << source_var
end

claims.each do |claim|
  fail!("compatibility claim entry must be a mapping") unless claim.is_a?(Hash)
  %w[id component_id status evidence notes].each do |key|
    fail!("compatibility claim #{claim["id"] || "<unknown>"} missing #{key}") unless claim.key?(key)
  end
  fail!("compatibility claim #{claim["id"]} references unknown component #{claim["component_id"]}") unless component_ids.include?(claim["component_id"])
  fail!("compatibility claim #{claim["id"]} evidence must be a non-empty list") unless claim["evidence"].is_a?(Array) && !claim["evidence"].empty?
end

gates.each do |gate|
  fail!("upgrade gate entry must be a mapping") unless gate.is_a?(Hash)
  %w[id component_id required_checks rollback_action].each do |key|
    fail!("upgrade gate #{gate["id"] || "<unknown>"} missing #{key}") unless gate.key?(key)
  end
  fail!("upgrade gate #{gate["id"]} references unknown component #{gate["component_id"]}") unless component_ids.include?(gate["component_id"])
  fail!("upgrade gate #{gate["id"]} required_checks must be a non-empty list") unless gate["required_checks"].is_a?(Array) && !gate["required_checks"].empty?
end

puts "runtime inventory tests passed"
RUBY

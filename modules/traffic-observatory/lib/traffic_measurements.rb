# frozen_string_literal: true
require 'json'
require 'digest'
require 'time'

# Source adapters describe measurements; this module owns their accounting.
module TrafficMeasurements
  CHANNELS = ['Home Wi-Fi/LAN', 'A/Home Reality', 'Channel B', 'Channel C',
              'Channel D', 'Channel anyT', 'Channel Snell', 'Channel Amn', 'Channel M'].freeze
  ISOLATED = {
    'anyT' => ['Channel anyT', 'isolated_profile_counter', 'isolated_channel_profile_counter', 'isolated_channel_counter_delta', ''],
    'Snell' => ['Channel Snell', 'isolated_profile_counter', 'isolated_channel_profile_counter', 'isolated_channel_counter_delta', ''],
    'Amn' => ['Channel Amn', 'isolated_profile_counter', 'amneziawg_peer_counter', 'amneziawg_peer_counter_delta', 'udp'],
    'D' => ['Channel D', 'completed_stream', 'caddy_connect_stream', 'caddy_connect_stream', 'tcp']
  }.freeze

  module_function

  def integer(value)
    Integer(value || 0)
  rescue ArgumentError, TypeError
    0
  end

  def stamp(value, fallback)
    Time.parse(value.to_s).utc.iso8601(3)
  rescue ArgumentError
    fallback
  end

  def identifier(*parts)
    Digest::SHA1.hexdigest(parts.map(&:to_s).join('|'))
  end

  # Legacy iptables histories have no process epoch. A decreasing component
  # contributes no bytes; independently increasing components remain observed.
  def increments(previous, current, components)
    resets = []
    values = components.map do |key|
      difference = integer(current[key]) - integer(previous[key])
      resets << key if difference < 0
      [difference, 0].max
    end
    [values, resets]
  end

  def lan_route_event?(row)
    return false unless row.is_a?(Hash)
    channel = row['channel'].to_s
    return channel == 'Home Wi-Fi/LAN' unless ['', 'Unknown'].include?(channel)
    # Older TSV lacked a channel column. Retain unscoped legacy evidence, but
    # reject an explicit ingress belonging to a different channel.
    tag = row['inbound'].to_s
    tag.empty? || tag.match?(/\A(?:redirect|tproxy)(?:-|\z)/)
  end

  def split(total, vps, direct, unknown)
    values = [total, vps, direct, unknown].map { |value| integer(value) }
    return [*values, false] if values.all? { |value| value >= 0 } && values[0] == values.drop(1).sum
    [[values[0], 0].max, 0, 0, [values[0], 0].max, true]
  end

  def route(vps, direct, unknown)
    present = [vps, direct, unknown].map { |value| value > 0 }
    return 'Mixed' if present.count(true) > 1
    return 'VPS' if present[0]
    return 'Direct' if present[1]
    'Unknown'
  end

  # Every byte-counter adapter ends here. Destination observations never enter
  # this calculation and therefore cannot allocate any overlapping counter.
  def counter_fact(sample, adapter, generated_at)
    return unless sample.is_a?(Hash)
    ts = stamp(sample['ts'], generated_at)
    if adapter == :lan
      return if sample['interval_start_utc'].to_s.empty?
      total, vps, direct, unknown, corrected = split(sample['total_bytes'], sample['vpn_bytes'], sample['direct_bytes'], sample['other_bytes'])
      key = sample['client_key'].to_s
      metadata = ['Home Wi-Fi/LAN', 'lan_route_counter', 'lan_device_route_counter', 'lan-device-counters', '']
      id = identifier('lan-volume', sample['sample_id'])
      allocation = 'client_counter_delta'
      identity = 'client_ip'
    elsif adapter == :home
      total, vps, direct, unknown, corrected = split(sample['total_bytes'], 0, 0, sample['total_bytes'])
      key = [sample['client_key'], sample['client_label'], sample['source_ip'], 'unknown-home-reality-profile'].find { |value| !value.to_s.empty? }.to_s
      metadata = ['A/Home Reality', 'home_profile_counter', 'home_reality_profile_counter', sample['source'].to_s.empty? ? 'mobile-reality-counters' : sample['source'], 'tcp']
      id = identifier('home-reality', sample['sample_id'], ts, key, total)
      allocation = sample['allocation_basis'].to_s.empty? ? 'observed_profile_counter_delta' : sample['allocation_basis']
      identity = sample['client_label'].to_s.empty? ? 'source_ip' : 'profile'
    else
      metadata = ISOLATED[sample['channel']]
      return unless metadata && [sample['bytes_up'], sample['bytes_down']].all? { |value| value.is_a?(Integer) && value >= 0 }
      total = sample['bytes_up'] + sample['bytes_down']
      vps, direct, unknown, corrected = 0, 0, total, false
      key = sample['client_key'].to_s
      id = identifier('isolated-channel-profile', sample['channel'], sample['sample_id'], key)
      allocation = metadata[1] == 'completed_stream' ? 'completed_proxy_stream' : 'observed_profile_counter_delta'
      identity = 'profile'
    end
    return if total <= 0 || key.empty? || sample['sample_id'].to_s.empty?
    channel, scope, level, source, protocol = metadata
    label = sample['client_label'].to_s.empty? ? key : sample['client_label']
    fact = {
      'fact_id' => id, 'flow_group_key' => id, 'sample_id' => sample['sample_id'],
      'event_ts' => ts, 'event_ts_utc' => ts, 'observed_at_utc' => ts, 'display_ts_utc' => ts,
      'time_precision' => 'second', 'client_key' => key, 'client_label' => label,
      'client_ip' => adapter == :lan ? sample['client_ip'].to_s : adapter == :home ? sample['source_ip'].to_s : '',
      'channel' => channel, 'route' => route(vps, direct, unknown),
      'intended_route' => 'Unknown', 'route_verification' => 'unknown', 'route_status' => 'unknown',
      'route_source' => '', 'route_basis' => '', 'matched_ipset' => '', 'egress_iface' => '', 'fwmark' => '',
      'traffic_class' => 'client', 'destination' => '', 'destination_kind' => 'unattributed_counter',
      'measurement_role' => 'volume', 'measurement_scope' => scope,
      'interval_start_utc' => sample['interval_start_utc'] || (stamp(sample['start'], ts) unless sample['start'].to_s.empty?),
      'interval_end_utc' => sample['interval_end_utc'] || ts,
      'destination_ip' => '', 'destination_port' => '', 'protocol' => protocol,
      'dns_qname' => '', 'dns_answer_ip' => '', 'dns_link_id' => '', 'dns_link_confidence' => 'no_dns_match',
      'dns_status' => 'no_match', 'dns_ts_source' => '', 'sni' => '', 'policy' => '', 'matched_rule' => '', 'outbound' => '',
      'bytes' => total, 'via_vps_bytes' => vps, 'direct_bytes' => direct, 'unknown_bytes' => unknown,
      'connections' => 0, 'identity_confidence' => identity,
      'byte_confidence' => adapter == :lan ? 'observed' : 'observed_delta',
      'destination_confidence' => 'none', 'confidence' => 'observed',
      'accounting_status' => corrected ? 'accounting_error' : 'ok', 'allocation_basis' => allocation,
      'evidence_level' => level, 'sources' => ['traffic-evidence', source],
      'evidence_json' => JSON.generate('sample' => sample)
    }
    if adapter != :lan
      fact['bytes_up'] = integer(sample['bytes_up'])
      fact['bytes_down'] = integer(sample['bytes_down'])
    end
    fact
  end

  def counter_facts(input, generated_at)
    { 'lan_device_route_deltas' => :lan, 'home_reality_samples' => :home,
      'isolated_channel_samples' => :isolated }.flat_map do |field, adapter|
      (input[field] || []).map { |sample| counter_fact(sample, adapter, generated_at) }.compact
    end
  end

  def annotate!(fact)
    kind = if fact['evidence_level'] == 'proxy_connection_event'
      'connection_event'
    elsif fact['evidence_level'] == 'caddy_connect_stream'
      'completed_stream'
    elsif fact['destination_kind'] == 'unattributed_counter'
      'counter_delta'
    else
      'flow_sample'
    end
    fact['measurement_kind'] = kind
    fact['sample_count'] = 1
    fact['connection_count'] = case kind
      when 'completed_stream', 'connection_event' then 1
      when 'flow_sample' then integer(fact['connections'])
      else nil
    end
  end

  def channel_coverage(facts)
    (CHANNELS + facts.map { |row| row['channel'] }).uniq.to_h do |channel|
      rows = facts.select { |row| row['channel'] == channel }
      volume = rows.reject { |row| row['measurement_role'] == 'detail' }
      detail = rows.select { |row| row['measurement_role'] == 'detail' }
      [channel, {
        'volume_status' => volume.empty? ? 'not_observed' : 'observed',
        'volume_bytes' => volume.sum { |row| integer(row['bytes']) },
        'route_known_bytes' => volume.sum { |row| integer(row['via_vps_bytes']) + integer(row['direct_bytes']) },
        'route_unknown_bytes' => volume.sum { |row| integer(row['unknown_bytes']) },
        'volume_samples' => volume.length, 'detail_samples' => detail.length,
        'connection_events' => rows.count { |row| row['measurement_kind'] == 'connection_event' },
        'destination_status' => rows.any? { |row| !row['destination'].to_s.empty? && row['destination_kind'] != 'unattributed_counter' } ? 'observed' : 'not_observed'
      }]
    end
  end
end

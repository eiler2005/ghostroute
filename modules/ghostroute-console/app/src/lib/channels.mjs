const descriptors = {
  A: { label: 'A/Home Reality', type: 'home_reality', lifecycle: 'production' },
  B: { label: 'Channel B', type: 'xhttp_home', lifecycle: 'production' },
  C: { label: 'Channel C', type: 'naive_compatibility', lifecycle: 'production' },
  D: { label: 'Channel D', type: 'naiveproxy', lifecycle: 'experimental' },
  anyT: { label: 'Channel anyT', type: 'anytls', lifecycle: 'production' },
  Snell: { label: 'Channel Snell', type: 'snell_shadowtls', lifecycle: 'experimental' },
  Amn: { label: 'Channel Amn', type: 'amneziawg', lifecycle: 'disabled_lab' },
};

export function channelId(value) {
  const key = String(value || '').trim().replace(/^channel[ _-]*/i, '').toLowerCase();
  if (key === 'anytls' || key === 'anyt') return 'anyT';
  if (key === 'snell') return 'Snell';
  if (key === 'amn') return 'Amn';
  return ['a', 'b', 'c', 'd'].includes(key) ? key.toUpperCase() : 'Unknown';
}

export function channelDescriptor(value) {
  return descriptors[channelId(value)] || { label: 'Unknown', type: 'unknown', lifecycle: 'unknown' };
}

// Inspect identity fields only. Application names and destination text are not ingress evidence.
export function explicitAccessChannel(row = {}) {
  const explicit = row.channel || row.raw?.channel;
  if (explicit && explicit !== 'Unknown') {
    const descriptor = channelDescriptor(explicit);
    return descriptor.label !== 'Unknown' ? descriptor.label : String(explicit);
  }
  const identity = [row.inbound, row.inbound_tag, row.profile_type, row.profile, row.client_key,
    row.raw?.inbound, row.raw?.inbound_tag, row.raw?.profile_type].filter(Boolean).join(' ').toLowerCase();
  if (/\b(?:channel[-_ ]?anytls|channel[-_ ]?anyt|anytls)[-_ ]/.test(identity + ' ')) return 'Channel anyT';
  if (/\b(?:channel[-_ ]?snell|snell)[-_ ]/.test(identity + ' ')) return 'Channel Snell';
  if (/\bchannel[-_ ]d\b|\bnaiveproxy\b/.test(identity)) return 'Channel D';
  return '';
}

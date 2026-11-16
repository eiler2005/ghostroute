import { channelId, channelDescriptor } from './channels.mjs';

export function channelHealthRows(inventory, snapshot, now = Date.now()) {
  const timestamp = Date.parse(snapshot?.generated_at || '');
  const observed = Number.isFinite(timestamp) && timestamp <= now + 60_000;
  const stale = observed && now - timestamp > 75 * 60_000;
  return ['D', 'anyT', 'Snell', 'Amn'].map(channel => {
    const descriptor = channelDescriptor(channel);
    const evidence = snapshot?.channels?.find(row => channelId(row.channel) === channel);
    const profiles = (inventory?.channel_profiles || []).filter(row => row.channel === channel).length;
    const runtime = evidence ? ['policy_running', 'ingress_running', 'watch_running', 'policy_current']
      .filter(key => typeof evidence[key] === 'boolean').map(key => [key, evidence[key]]) : [];
    let status = 'NOT OBSERVED';
    if (observed && evidence) {
      if (stale) status = 'STALE';
      else if (evidence.enabled === false) status = channel === 'anyT' && evidence.installed ? 'WARN' : 'DISABLED';
      else if (runtime.length && runtime.every(([, value]) => value === true)) status = 'OK';
      else if (evidence.enabled === true) status = 'CRIT';
      else if (runtime.some(([, value]) => value === true)) status = 'WARN';
    }
    return { channel, label: descriptor.label, protocol: descriptor.type, lifecycle: descriptor.lifecycle,
      status, profiles, generated_at: observed ? snapshot.generated_at : '',
      runtime: runtime.map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value ? 'observed' : 'not observed'}`).join('; ') || 'Runtime not observed',
      application: 'Application probe not observed', coverage: 'Traffic coverage depends on the channel collector and available samples' };
  });
}

"""Extract only named Amn peer byte counters from private UAPI data."""
import base64
import ipaddress


def profile_keys(settings):
    network = ipaddress.ip_network(settings['subnet'])
    slots = {str(network[2 if n == 1 else n + 2]): 'Amn-%02d' % n for n in range(1, 9)}
    result = {}
    for peer in settings['peers']:
        slot = slots.get(peer['address'])
        if slot:
            key = base64.b64decode(peer['public_key'], validate=True)
            if len(key) != 32 or key.hex() in result:
                raise ValueError('invalid peer identity')
            result[key.hex()] = slot
    if not result:
        raise ValueError('no configured client peers')
    return result


def extract(settings, response):
    mapping = profile_keys(settings)
    seen, values = set(), {}
    current = None
    for line in response.splitlines():
        key, sep, value = line.partition('=')
        if not sep:
            continue
        if key == 'public_key':
            current = mapping.get(value)
            if current:
                if current in seen:
                    raise ValueError('duplicate peer')
                seen.add(current)
                values[current] = {}
        elif current and key in ('rx_bytes', 'tx_bytes'):
            if not value.isascii() or not value.isdigit() or key in values[current]:
                raise ValueError('invalid peer counter')
            values[current][key] = int(value)
    if 'errno=0' not in response.splitlines() or seen != set(mapping.values()):
        raise ValueError('incomplete peer response')
    stats = {}
    for slot, counters in values.items():
        if set(counters) != {'rx_bytes', 'tx_bytes'}:
            raise ValueError('missing peer counter')
        stats['user>>>%s>>>traffic>>>uplink' % slot] = counters['rx_bytes']
        stats['user>>>%s>>>traffic>>>downlink' % slot] = counters['tx_bytes']
    return stats

"""Pure outage-window policy. Unknown/local failures never authorize a switch."""
def observe(previous, now, boot, healthy, local_ok, threshold=1800, max_gap=420):
    if previous.get('boot') != boot or now < previous.get('last', now) or now-previous.get('last', now) > max_gap:
        previous = {}
    state = {'boot': boot, 'last': now, 'failure_since': None, 'switch': False}
    if healthy or not local_ok:
        return state
    state['failure_since'] = previous.get('failure_since')
    if state['failure_since'] is None: state['failure_since'] = now
    state['switch'] = now-state['failure_since'] >= threshold
    return state

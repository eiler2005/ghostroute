"""Bounded, single-owner duplex I/O, including SSLSocket WANT_READ/WANT_WRITE."""
import select
import ssl
import time


def relay(left, right, idle_timeout=300, on_transfer=None):
    peers = {left: right, right: left}
    queued = {left: bytearray(), right: bytearray()}
    sending = {left: None, right: None}
    read_wait = {left: 'read', right: 'read'}
    write_wait = {left: 'write', right: 'write'}
    ended = False
    deadline = time.monotonic() + idle_timeout
    for connection in peers:
        connection.setblocking(False)
    while True:
        if ended and not any(queued.values()):
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        reads, writes, buffered = set(), set(), set()
        reading = set()
        for connection, peer in peers.items():
            if not ended and len(queued[peer]) < 262144:
                reading.add(connection)
                (reads if read_wait[connection] == 'read' else writes).add(connection)
                if isinstance(connection, ssl.SSLSocket) and connection.pending():
                    buffered.add(connection)
            if queued[connection]:
                (reads if write_wait[connection] == 'read' else writes).add(connection)
        readable, writable, _ = select.select(list(reads), list(writes), [], 0 if buffered else remaining)
        ready = {'read': set(readable), 'write': set(writable)}
        for connection, peer in peers.items():
            if connection in reading and (connection in ready[read_wait[connection]] or connection in buffered):
                try:
                    data = connection.recv(65536)
                    read_wait[connection] = 'read'
                    if data:
                        queued[peer].extend(data)
                        deadline = time.monotonic() + idle_timeout
                    else:
                        ended = True
                except ssl.SSLWantWriteError:
                    read_wait[connection] = 'write'
                except (ssl.SSLWantReadError, BlockingIOError):
                    read_wait[connection] = 'read'
            if queued[connection] and connection in ready[write_wait[connection]]:
                # SSL_write retries keep the same bytes/length even while the
                # opposite direction appends more queued bytes.
                if sending[connection] is None:
                    sending[connection] = bytes(queued[connection][:65536])
                try:
                    count = connection.send(sending[connection])
                    if count <= 0:
                        return
                    del queued[connection][:count]
                    if on_transfer:
                        on_transfer('sent' if connection is right else 'received', count)
                    sending[connection] = None
                    write_wait[connection] = 'write'
                    deadline = time.monotonic() + idle_timeout
                except ssl.SSLWantReadError:
                    write_wait[connection] = 'read'
                except (ssl.SSLWantWriteError, BlockingIOError):
                    write_wait[connection] = 'write'

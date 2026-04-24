#!/usr/bin/env bash
# Validate a single SNI candidate for Reality use.
# Exit 0 means the candidate satisfies the local TLS/HTTP checks.

set -u

HOST="${1:?usage: $0 <hostname>}"
PORT=443
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { printf "  [ok]  %s\n" "$*"; }
fail() { printf "  [FAIL] %s\n" "$*"; EXIT_CODE=1; }

EXIT_CODE=0
echo "== Validating $HOST:$PORT =="

# curl is only used for HTTPS reachability and certificate verification here.
# TLS 1.3 + X25519 are checked below with openssl because macOS curl may list
# TLS flags that its linked libcurl cannot actually execute.
if curl -sI --max-time 10 "https://$HOST/" \
    -o "$TMP/headers" -w "%{http_code} %{ssl_verify_result}\n" > "$TMP/curl" 2>"$TMP/err"; then
  read -r CODE VERIFY < "$TMP/curl"
  if [[ "$VERIFY" == "0" ]]; then
    pass "HTTPS reachability OK, cert verified, HTTP $CODE"
  else
    fail "TLS cert verify failed (verify_result=$VERIFY)"
  fi

  if [[ "$CODE" =~ ^(2|3|400|401|403)$ ]]; then
    pass "HTTP response acceptable ($CODE)"
  else
    fail "HTTP response unacceptable ($CODE)"
  fi
else
  fail "curl failed: $(cat "$TMP/err")"
fi

OPENSSL_OUT="$(echo | openssl s_client -connect "$HOST:$PORT" -servername "$HOST" \
  -tls1_3 -groups X25519 -alpn h2,http/1.1 -showcerts 2>/dev/null)"

if echo "$OPENSSL_OUT" | grep -q "Protocol.*TLSv1.3"; then
  pass "Confirmed TLSv1.3 protocol"
else
  fail "TLSv1.3 not confirmed"
fi

if echo "$OPENSSL_OUT" | grep -qE "Server Temp Key.*X25519|X25519"; then
  pass "X25519 key exchange confirmed"
else
  fail "X25519 not confirmed"
fi

if echo "$OPENSSL_OUT" | grep -qE "ALPN protocol:.*(h2|http/1.1)"; then
  pass "ALPN OK: $(echo "$OPENSSL_OUT" | grep 'ALPN protocol')"
else
  fail "ALPN not h2 or http/1.1"
fi

CERT_PEM="$(echo "$OPENSSL_OUT" | awk '/BEGIN CERTIFICATE/{flag=1} flag{print} /END CERTIFICATE/{exit}')"
CERT_SUBJECTS="$(echo "$CERT_PEM" | openssl x509 -noout -text 2>/dev/null | sed -n '/Subject Alternative Name/,+2p' || true)"
BASE_DOMAIN="$(printf '%s\n' "$HOST" | cut -d. -f2-)"
if echo "$CERT_SUBJECTS" | grep -qiE "DNS:${HOST//./\\.}(,|$)|DNS:\\*\\.${BASE_DOMAIN//./\\.}(,|$)"; then
  pass "Cert SAN covers $HOST"
else
  fail "Cert SAN does not obviously cover $HOST; inspect manually"
  echo "$CERT_SUBJECTS" | sed 's/^/      /'
fi

LATENCY_MS="$(curl -s -o /dev/null -w "%{time_connect}\n" --max-time 10 "https://$HOST/" \
  | awk '{print int($1*1000)}')"
if [[ -n "$LATENCY_MS" && "$LATENCY_MS" -gt 0 && "$LATENCY_MS" -lt 500 ]]; then
  pass "TCP connect latency ${LATENCY_MS}ms (reasonable)"
else
  fail "TCP connect latency ${LATENCY_MS}ms (too high or unreachable)"
fi

echo "== $HOST: $([ "$EXIT_CODE" -eq 0 ] && echo PASS || echo FAIL) =="
exit "$EXIT_CODE"

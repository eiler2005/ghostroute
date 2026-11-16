package main

import (
 "testing"
 "google.golang.org/protobuf/encoding/protowire"
)

func TestValidAddress(t *testing.T) {
 for _, tc := range []struct{ address string; valid bool }{
  {"127.0.0.1:12099", true}, {"localhost:12099", false},
  {"0.0.0.0:12099", false}, {"127.0.0.1:80", false},
  {"127.0.0.1:65536", false}, {"127.0.0.1:12099:22", false},
 } {
  if validAddress(tc.address) != tc.valid { t.Errorf("unexpected validation for %q", tc.address) }
 }
}

func TestDecodeStats(t *testing.T) {
 entry := protowire.AppendTag(nil, 1, protowire.BytesType)
 entry = protowire.AppendString(entry, "user>>>fixture>>>traffic>>>uplink")
 entry = protowire.AppendTag(entry, 2, protowire.VarintType)
 entry = protowire.AppendVarint(entry, 123)
 message := protowire.AppendTag(nil, 1, protowire.BytesType)
 message = protowire.AppendBytes(message, entry)
 stats, err := parseStats(message)
 if err != nil || stats["user>>>fixture>>>traffic>>>uplink"] != 123 { t.Fatal("counter decoding failed") }
 if _, err := parseStats([]byte{0xff}); err == nil { t.Fatal("malformed protobuf was accepted") }
}

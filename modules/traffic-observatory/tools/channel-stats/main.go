package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/encoding/protowire"
)

// The v2ray StatsService has a tiny protobuf surface; the empty request and
// response decoder avoid shipping the full v2ray runtime on the router.
type codec struct{}

func (codec) Name() string { return "proto" }
func (codec) Marshal(any) ([]byte, error) { return []byte{}, nil }
func (codec) Unmarshal(b []byte, v any) error {
	*(v.(*[]byte)) = append([]byte(nil), b...)
	return nil
}

func validAddress(address string) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n > 1024 && n <= 65535
}

func parseEntry(data []byte) (string, uint64, error) {
	var name string
	var value uint64
	for len(data) > 0 {
		field, wire, n := protowire.ConsumeTag(data)
		if n < 0 { return "", 0, errors.New("invalid entry tag") }
		data = data[n:]
		switch {
		case field == 1 && wire == protowire.BytesType:
			v, size := protowire.ConsumeBytes(data)
			if size < 0 { return "", 0, errors.New("invalid entry name") }
			name, data = string(v), data[size:]
		case field == 2 && wire == protowire.VarintType:
			v, size := protowire.ConsumeVarint(data)
			if size < 0 { return "", 0, errors.New("invalid entry value") }
			value, data = v, data[size:]
		default:
			size := protowire.ConsumeFieldValue(field, wire, data)
			if size < 0 { return "", 0, errors.New("invalid entry field") }
			data = data[size:]
		}
	}
	return name, value, nil
}

func parseStats(data []byte) (map[string]uint64, error) {
	stats := make(map[string]uint64)
	for len(data) > 0 {
		field, wire, n := protowire.ConsumeTag(data)
		if n < 0 { return nil, errors.New("invalid response tag") }
		data = data[n:]
		if field != 1 || wire != protowire.BytesType {
			size := protowire.ConsumeFieldValue(field, wire, data)
			if size < 0 { return nil, errors.New("invalid response field") }
			data = data[size:]
			continue
		}
		entry, size := protowire.ConsumeBytes(data)
		if size < 0 { return nil, errors.New("invalid response entry") }
		data = data[size:]
		name, value, err := parseEntry(entry)
		if err != nil { return nil, err }
		if name != "" { stats[name] = value }
	}
	return stats, nil
}

func run(address string) error {
	if !validAddress(address) { return errors.New("invalid loopback listener") }
	conn, err := grpc.NewClient(address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil { return err }
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var data []byte
	if err := conn.Invoke(ctx, "/v2ray.core.app.stats.command.StatsService/QueryStats", []byte{}, &data, grpc.ForceCodec(codec{})); err != nil { return err }
	stats, err := parseStats(data)
	if err != nil { return err }
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"stat": stats})
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: channel-stats 127.0.0.1:port")
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "statistics query failed:", err)
		os.Exit(1)
	}
}

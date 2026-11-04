// Amn probe uses an in-process network stack; it never changes the Mac's routes.
package main

import (
    "context"
    "encoding/base64"
    "encoding/hex"
    "encoding/json"
    "flag"
    "fmt"
    "io"
    "net"
    "net/http"
    "net/netip"
    "os"
    "sort"
    "strings"
    "time"

    "github.com/amnezia-vpn/amneziawg-go/v3/conn"
    "github.com/amnezia-vpn/amneziawg-go/v3/device"
    "github.com/amnezia-vpn/amneziawg-go/v3/tun/netstack"
)

type Config struct {
    PrivateKey string `json:"private_key"`
    PublicKey string `json:"public_key"`
    PresharedKey string `json:"preshared_key"`
    Address string `json:"address"`
    DNS string `json:"dns"`
    Endpoint string `json:"endpoint"`
    Port int `json:"port"`
    MTU int `json:"mtu"`
    Obfuscation map[string]int `json:"obfuscation"`
}

func key(value string) string {
    b, err := base64.StdEncoding.DecodeString(value)
    if err != nil || len(b) != 32 { panic("Invalid key") }
    return hex.EncodeToString(b)
}

func run() error {
    configPath := flag.String("config", "", "Private peer JSON")
    url := flag.String("url", "", "HTTPS probe URL; body is operator-private output")
    endpoint := flag.String("endpoint", "", "Optional endpoint override for LAN proof")
    flag.Parse()
    var raw []byte
    var err error
    if *configPath == "-" {
        raw, err = io.ReadAll(io.LimitReader(os.Stdin, 16384))
    } else {
        raw, err = os.ReadFile(*configPath)
    }
    if err != nil { return err }
    var c Config
    if err = json.Unmarshal(raw, &c); err != nil { return err }
    if *endpoint != "" { c.Endpoint = *endpoint }
    tun, network, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr(c.Address)}, []netip.Addr{netip.MustParseAddr(c.DNS)}, c.MTU)
    if err != nil { return err }
    dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
    defer dev.Close()
    var lines []string
    lines = append(lines, "private_key=" + key(c.PrivateKey))
    var keys []string
    for k := range c.Obfuscation { keys = append(keys, k) }; sort.Strings(keys)
    for _, k := range keys { lines = append(lines, fmt.Sprintf("%s=%d", k, c.Obfuscation[k])) }
    lines = append(lines, "public_key=" + key(c.PublicKey), "preshared_key=" + key(c.PresharedKey),
        "allowed_ip=0.0.0.0/0", fmt.Sprintf("endpoint=%s:%d", c.Endpoint, c.Port), "persistent_keepalive_interval=25")
    if err = dev.IpcSet(strings.Join(lines, "\n") + "\n"); err != nil { return err }
    if err = dev.Up(); err != nil { return err }
    ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second); defer cancel()
    request, err := http.NewRequestWithContext(ctx, "GET", *url, nil); if err != nil { return err }
    stage := "dns"
    dial := func(ctx context.Context, _ string, address string) (net.Conn, error) {
        host, port, err := net.SplitHostPort(address)
        if err != nil { return nil, err }
        ips, err := network.LookupContextHost(ctx, host)
        if err != nil { return nil, err }
        for _, value := range ips {
            ip, err := netip.ParseAddr(value)
            if err != nil || !ip.Is4() { continue }
            stage = "tcp"
            conn, err := network.DialContext(ctx, "tcp4", net.JoinHostPort(value, port))
            if err == nil { stage = "tls_http" }
            return conn, err
        }
        return nil, fmt.Errorf("no IPv4 answer for lab probe")
    }
    transport := &http.Transport{DialContext: dial, ForceAttemptHTTP2: false}
    defer transport.CloseIdleConnections()
    client := &http.Client{Transport: transport}
    response, err := client.Do(request); if err != nil { return fmt.Errorf("stage=%s: %w", stage, err) }
    defer response.Body.Close()
    body, err := io.ReadAll(io.LimitReader(response.Body, 16384)); if err != nil { return err }
    state, err := dev.IpcGet(); if err != nil { return err }
    handshake := false
    for _, line := range strings.Split(state, "\n") {
        if strings.HasPrefix(line, "last_handshake_time_sec=") && line != "last_handshake_time_sec=0" { handshake = true }
    }
    return json.NewEncoder(os.Stdout).Encode(map[string]any{"status": response.StatusCode, "handshake": handshake, "body": string(body)})
}

func main() {
    if err := run(); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
}

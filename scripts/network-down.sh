#!/usr/bin/env bash
# Best-effort teardown of the guest network created by network-up.sh. Safe to run
# even if some rules are absent (each delete is guarded).
set -uo pipefail

HOST_IFACE="$(cat /tmp/mv-host-iface 2>/dev/null || true)"
DNS_RESOLVER="$(cat /tmp/mv-dns-resolver 2>/dev/null || echo 8.8.8.8)"

sudo iptables -t nat -D PREROUTING -i tap0 -p tcp --dport 443 -j REDIRECT --to-ports 8080 2>/dev/null || true
if [ -n "$HOST_IFACE" ]; then
  sudo iptables -t nat -D POSTROUTING -o "$HOST_IFACE" -j MASQUERADE 2>/dev/null || true
  sudo iptables -D FORWARD -i "$HOST_IFACE" -o tap0 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
fi
sudo iptables -D FORWARD -i tap0 -j DROP 2>/dev/null || true
sudo iptables -D FORWARD -i tap0 -p tcp -d "$DNS_RESOLVER" --dport 53 -j ACCEPT 2>/dev/null || true
sudo iptables -D FORWARD -i tap0 -p udp -d "$DNS_RESOLVER" --dport 53 -j ACCEPT 2>/dev/null || true
sudo iptables -D INPUT -i tap0 -p tcp --dport 9000 -j ACCEPT 2>/dev/null || true

sudo ip link del tap0 2>/dev/null || true
echo "network down"

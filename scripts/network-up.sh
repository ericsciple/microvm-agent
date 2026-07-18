#!/usr/bin/env bash
# Bring up the guest network: tap0 + NAT + host-enforced firewall + gateway
# redirect. Ported verbatim-in-spirit from the proven phase3/phase4 recipe.
#
# The firewall is enforced on the HOST tap device, so in-guest root cannot lift
# it: default-DROP egress from tap0, with holes only for DNS, the host dispatch
# port (9000), and :443 REDIRECTed to the credential gateway (8080).
set -euo pipefail

sudo ip link del tap0 2>/dev/null || true
sudo ip tuntap add dev tap0 mode tap
sudo ip addr add 172.16.0.1/30 dev tap0
sudo ip link set tap0 up
sudo sysctl -w net.ipv4.ip_forward=1
sudo sysctl -w net.ipv4.conf.all.send_redirects=0

HOST_IFACE=$(ip -j route list default | jq -r '.[0].dev')
echo "$HOST_IFACE" > /tmp/mv-host-iface
echo "host iface: ${HOST_IFACE}"

sudo iptables -I INPUT 1 -i tap0 -p tcp --dport 9000 -j ACCEPT
sudo iptables -I FORWARD 1 -i "$HOST_IFACE" -o tap0 -m state --state RELATED,ESTABLISHED -j ACCEPT
sudo iptables -I FORWARD 2 -i tap0 -p udp --dport 53 -j ACCEPT
sudo iptables -I FORWARD 3 -i tap0 -p tcp --dport 53 -j ACCEPT
sudo iptables -I FORWARD 4 -i tap0 -j DROP
sudo iptables -t nat -A POSTROUTING -o "$HOST_IFACE" -j MASQUERADE
sudo iptables -t nat -A PREROUTING -i tap0 -p tcp --dport 443 -j REDIRECT --to-ports 8080

echo "network up (tap0 172.16.0.1/30, gateway :8080, dispatch :9000)"

#!/bin/sh
# One-time setup on the server: domain, secrets, LiveKit config and (Oracle Cloud images) the
# machine's own firewall. Runs on any Linux with Docker, amd64 or arm64 (Oracle Ampere A1).
set -e
cd "$(dirname "$0")"

private_ip() { echo "$1" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)'; }

if [ ! -f .env ]; then
  # The machine's own address. On Oracle Cloud (and AWS, GCP…) that is a private one: the public
  # address is in the cloud console (instance page, "Public IP address").
  IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  IP=${IP:-$(hostname -I | awk '{print $1}')}
  if private_ip "$IP"; then
    printf 'Public IP of this server (from the cloud console): '
    read -r IP
  fi
  DEFAULT_DOMAIN=$(echo "$IP" | tr . -).sslip.io
  printf 'Domain for the relay [%s]: ' "$DEFAULT_DOMAIN"
  read -r DOMAIN
  DOMAIN=${DOMAIN:-$DEFAULT_DOMAIN}
  rnd() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-"$1"; }
  {
    echo "DOMAIN=$DOMAIN"
    private_ip "$IP" || echo "PUBLIC_IP=$IP"
    echo "LIVEKIT_API_KEY=API$(rnd 12)"
    echo "LIVEKIT_API_SECRET=$(rnd 48)"
    echo "RELAY_KEY=$(rnd 40)"
  } > .env
  chmod 600 .env
fi
. ./.env
# With the public address known, LiveKit announces it directly; otherwise it asks a STUN server.
if [ -n "$PUBLIC_IP" ]; then
  sed -e "s/__DOMAIN__/$DOMAIN/" -e "s/use_external_ip: true/use_external_ip: false\n  node_ip: $PUBLIC_IP/" livekit.template.yaml > livekit.yaml
else
  sed "s/__DOMAIN__/$DOMAIN/" livekit.template.yaml > livekit.yaml
fi

# Oracle Cloud's Ubuntu images ship an iptables rule that rejects everything but SSH, on top of
# the cloud's own Security List. Open our ports here too (saved, so they survive a reboot).
TCP_PORTS="80 443 7881"
UDP_PORTS="3478 50000:50200"
if command -v iptables >/dev/null 2>&1 && sudo iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  printf 'This machine firewall blocks incoming traffic (Oracle image). Open the relay ports in it? [Y/n] '
  read -r ok
  if [ "${ok:-y}" != "n" ] && [ "${ok:-y}" != "N" ]; then
    for p in $TCP_PORTS; do sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -m state --state NEW -j ACCEPT; done
    for p in $UDP_PORTS; do sudo iptables -C INPUT -p udp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p udp --dport "$p" -j ACCEPT; done
    if command -v netfilter-persistent >/dev/null 2>&1; then sudo netfilter-persistent save >/dev/null; else echo "(install iptables-persistent to keep these after a reboot)"; fi
    echo "Opened on this machine: TCP $TCP_PORTS · UDP $UDP_PORTS"
  fi
fi

echo
echo "Ready. Also open these ports in the cloud's firewall (Oracle: VCN > Security List > Ingress Rules, source 0.0.0.0/0):"
echo "  TCP 80, 443, 7881      UDP 3478, 50000-50200"
echo "Then run:  sudo docker compose up -d"
echo
echo "For the app (build with these):"
echo "  VITE_RELAY_URL=https://$DOMAIN"
echo "  VITE_RELAY_KEY=$RELAY_KEY"

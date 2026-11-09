#!/usr/bin/env bash
# Read-only network diagnostics for the benchmark harness.
#
# Prints the resolved benchmark network config (including proxy variables), the host
# LAN IP and the Docker daemon proxy, and warns when the daemon proxy looks stale.
# Writes nothing and never changes the daemon configuration.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=network.sh
source "$HERE/network.sh"

echo "== benchmark network (source: network.sh)"
dsh_network_show

echo
echo "== host LAN IP"
host_ip=""
if command -v ipconfig >/dev/null 2>&1; then
  host_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  echo "${host_ip:-(en0 has no address)}"
else
  echo "(ipconfig not available; this check is macOS/Colima-oriented)"
fi

echo
echo "== Docker daemon proxy"
daemon_proxy=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  daemon_proxy="$(docker info 2>/dev/null | awk -F': ' '/HTTP Proxy:/{print $2; exit}')"
  echo "${daemon_proxy:-(unset)}"
  if [ -n "$daemon_proxy" ] && [ -n "$host_ip" ]; then
    case "$daemon_proxy" in
      *"$host_ip"*) ;;
      *) echo "WARN: daemon proxy does not point at the current host IP ($host_ip);" \
              "update it in the Colima VM (bench/README.md#network-setup-mirrors--proxy)" ;;
    esac
  fi
else
  echo "(docker unavailable)"
fi

echo
echo "Offline regression check: bash $HERE/check-network.sh"

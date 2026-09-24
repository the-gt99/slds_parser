#!/usr/bin/env bash
set -euo pipefail

action=${1:?action is required}
wireguard_interface=${2:-wg0}
external_interface=${3:?external interface is required}
subnet=${4:-10.77.0.0/24}

filter_input=SLDS_SHIHUO_INPUT
filter_forward=SLDS_SHIHUO_FWD
nat_prerouting=SLDS_SHIHUO_PRE
nat_postrouting=SLDS_SHIHUO_POST

attach() {
  local table=$1 parent=$2 chain=$3
  iptables -w -t "$table" -C "$parent" -j "$chain" 2>/dev/null || iptables -w -t "$table" -I "$parent" 1 -j "$chain"
}

detach() {
  local table=$1 parent=$2 chain=$3
  while iptables -w -t "$table" -C "$parent" -j "$chain" 2>/dev/null; do
    iptables -w -t "$table" -D "$parent" -j "$chain"
  done
}

create_chain() {
  local table=$1 chain=$2
  iptables -w -t "$table" -N "$chain" 2>/dev/null || iptables -w -t "$table" -F "$chain"
}

if [[ "$action" == "up" ]]; then
  create_chain filter "$filter_input"
  create_chain filter "$filter_forward"
  create_chain nat "$nat_prerouting"
  create_chain nat "$nat_postrouting"

  iptables -w -A "$filter_input" -i "$external_interface" -p udp --dport 51820 -j ACCEPT
  iptables -w -A "$filter_input" -i "$wireguard_interface" -p tcp --dport 8080 -j ACCEPT
  iptables -w -A "$filter_input" -j RETURN

  iptables -w -A "$filter_forward" -i "$wireguard_interface" -o "$wireguard_interface" -j REJECT
  iptables -w -A "$filter_forward" -i "$wireguard_interface" -o "$external_interface" -p udp --dport 53 -j ACCEPT
  iptables -w -A "$filter_forward" -i "$wireguard_interface" -o "$external_interface" -p tcp --dport 53 -j ACCEPT
  iptables -w -A "$filter_forward" -i "$external_interface" -o "$wireguard_interface" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -w -A "$filter_forward" -i "$wireguard_interface" -j REJECT
  iptables -w -A "$filter_forward" -j RETURN

  iptables -w -t nat -A "$nat_prerouting" -i "$wireguard_interface" -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports 8080
  iptables -w -t nat -A "$nat_prerouting" -j RETURN
  iptables -w -t nat -A "$nat_postrouting" -s "$subnet" -o "$external_interface" -j MASQUERADE
  iptables -w -t nat -A "$nat_postrouting" -j RETURN

  attach filter INPUT "$filter_input"
  attach filter FORWARD "$filter_forward"
  attach nat PREROUTING "$nat_prerouting"
  attach nat POSTROUTING "$nat_postrouting"
elif [[ "$action" == "down" ]]; then
  detach filter INPUT "$filter_input"
  detach filter FORWARD "$filter_forward"
  detach nat PREROUTING "$nat_prerouting"
  detach nat POSTROUTING "$nat_postrouting"
  iptables -w -F "$filter_input" 2>/dev/null || true
  iptables -w -X "$filter_input" 2>/dev/null || true
  iptables -w -F "$filter_forward" 2>/dev/null || true
  iptables -w -X "$filter_forward" 2>/dev/null || true
  iptables -w -t nat -F "$nat_prerouting" 2>/dev/null || true
  iptables -w -t nat -X "$nat_prerouting" 2>/dev/null || true
  iptables -w -t nat -F "$nat_postrouting" 2>/dev/null || true
  iptables -w -t nat -X "$nat_postrouting" 2>/dev/null || true
else
  echo "unknown action: $action" >&2
  exit 2
fi

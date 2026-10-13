#!/usr/bin/env bash
# The exec worker owns the service/sandbox and the complete network lifecycle.
# Loading this module defines functions only; the worker owns its EXIT trap.

cleanup_spoof_address() {
  if [ -n "$SPOOF_NS" ] && [ -n "$SPOOF_IP" ]; then
    sudo ip -n "$SPOOF_NS" address delete "${SPOOF_IP}/32" \
      dev veth0 2>/dev/null || true
  fi
  SPOOF_NS=""
  SPOOF_IP=""
}

check_dns_isolation_peer() {
  local family=$1 address=$2 peer=$3 output
  if output=$(sudo ip netns exec "$DNS_ISOLATION_NS" \
    ping "-$family" -c 1 -W 1 "$address" 2>&1); then
    return
  fi

  # Preserve the failed probe and its network state before teardown removes the
  # fixture. A later service stop is not evidence of the original failure.
  printf '%s\n' "$output"
  sudo ip -details address show dev "$DNS_ISOLATION_HOST_IF" || true
  sudo ip -n "$DNS_ISOLATION_NS" -details address show || true
  sudo ip -n "$DNS_ISOLATION_NS" "-$family" route get "$address" || true
  sudo ip -n "$DNS_ISOLATION_NS" "-$family" neighbour show || true
  # A second connected route for these addresses means another interface still
  # owns the fixture subnet: the host answers the probe's neighbour discovery on
  # the new interface but sends the reply through the other one, so the probe
  # times out even though the neighbour resolves.
  sudo ip "-$family" route show to match "$address" || true
  sudo ip "-$family" route get "$peer" || true
  sudo iptables-save -c -t filter || true
  sudo ip6tables-save -c -t filter || true
  fail "temporary non-runner veth cannot reach its IPv${family} host peer"
}

reclaim_leaked_dns_isolation_fixtures() {
  local namespace interface

  # A killed run cannot execute the EXIT trap, so its namespace and host
  # interface can outlive it on this long-lived host. Both the addresses and the
  # namespace name are derived from this service, so a survivor keeps holding
  # the subnet that the fixture below is about to claim. The caller already owns
  # the DNS isolation lock, so no other fixture is inside its critical section
  # and anything still using these names is leaked.
  for namespace in $(sudo ip netns list | awk '{ print $1 }' \
    | grep '^dns-isolation-'); do
    echo "reclaiming leaked DNS isolation namespace $namespace"
    sudo ip netns delete "$namespace" || true
  done

  # Deleting a namespace also removes the veth pair it holds, so this only finds
  # a host interface whose namespace was already gone.
  for interface in $(sudo ip -oneline link show | awk -F '[:@ ]+' '{ print $2 }' \
    | grep '^vmdh'); do
    echo "reclaiming leaked DNS isolation interface $interface"
    sudo ip link delete "$interface" || true
  done
}

cleanup_pool_lock_guard() {
  if [ -n "$POOL_LOCK_PUBLISH_RELEASE" ]; then
    touch "$POOL_LOCK_PUBLISH_RELEASE" 2>/dev/null || true
  fi
  if [ -n "$POOL_LOCK_RELEASE_FD" ]; then
    exec {POOL_LOCK_RELEASE_FD}>&-
    POOL_LOCK_RELEASE_FD=""
  fi
  if [ -n "$POOL_LOCK_HOLDER_PID" ]; then
    wait "$POOL_LOCK_HOLDER_PID" 2>/dev/null || true
    POOL_LOCK_HOLDER_PID=""
  fi
  if [ -n "$POOL_LOCK_GUARD_DIR" ]; then
    rm -rf "$POOL_LOCK_GUARD_DIR"
    POOL_LOCK_GUARD_DIR=""
  fi
  POOL_LOCK_HOLDER_STATUS=""
  POOL_LOCK_PUBLISH_RELEASE=""
  POOL_LOCK_ERROR=""
}

rule_values() {
  local option=$1
  awk -v option="$option" '
    {
      for (i = 1; i < NF; i++) {
        if ($i == option) {
          value = $(i + 1)
          gsub(/^"|"$/, "", value)
          print value
        }
      }
    }
  '
}

rule_value() {
  local rule=$1 option=$2
  printf '%s\n' "$rule" | rule_values "$option" | head -n 1
}

rule_packet_count() {
  local rule=$1
  printf '%s\n' "$rule" | awk '
    $1 ~ /^\[[0-9]+:[0-9]+\]$/ {
      gsub(/^\[/, "", $1)
      split($1, counter, ":")
      print counter[1]
      exit
    }
  '
}

link_identity_fields() {
  local expected_ifname=$1
  jq -er --arg expected_ifname "$expected_ifname" '
    if type == "array"
      and length == 1
      and .[0].ifname == $expected_ifname
    then
      [
        .[0].ifindex,
        .[0].link_index
      ] | @tsv
    else
      error("expected exactly one link named \($expected_ifname)")
    end
  '
}

send_udp_dns_query() {
  local namespace=$1 source_ip=$2 destination_ip=$3
  sudo ip netns exec "$namespace" python3 - "$source_ip" "$destination_ip" <<'PY'
import socket
import sys

query = bytes.fromhex(
    "123401000001000000000000"
    "0c736f757263652d6775617264"
    "07696e76616c69640000010001"
)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((sys.argv[1], 0))
sock.sendto(query, (sys.argv[2], 53))
sock.close()
PY
}

exec_network_pre_submit() {
# Inspect the rules while the prewarmed namespace pool is fully idle. Matching
# by this runner's unique proxy and DNS ports avoids parallel CI runners on the
# host, and running before local submit avoids holding a Firecracker VM during
# the source-identity probe.
STATUS_PORTS=$(sudo jq -er '
  [.proxy_port, .dns_port]
  | select(all(.[]; type == "number"))
  | @tsv
' "$RUNNER_DIR/status.json") \
  || fail "proxy or DNS port missing from runner status"
read -r PROXY_PORT DNS_PORT <<< "$STATUS_PORTS"
[ -n "$PROXY_PORT" ] || fail "proxy port missing from runner status"
[ -n "$DNS_PORT" ] || fail "DNS port missing from runner status"

DNS_LISTENERS=$(sudo ss -H -luntp \
  | grep -E ":${DNS_PORT}[[:space:]]" || true)
DNS_LISTENER_COUNT=$(printf '%s\n' "$DNS_LISTENERS" \
  | grep -c . || true)
[ "$DNS_LISTENER_COUNT" -ge 2 ] \
  || fail "expected UDP/TCP dnsmasq wildcard listeners, found $DNS_LISTENER_COUNT"
[ "$DNS_LISTENER_COUNT" -le 4 ] \
  || fail "dnsmasq created per-address listeners: $DNS_LISTENERS"
if printf '%s\n' "$DNS_LISTENERS" \
  | grep -E '10\.200\.|%vm0-ve-' >/dev/null; then
  fail "dnsmasq listener set contains VM interface addresses: $DNS_LISTENERS"
fi

NAT_RULES=$(sudo iptables-save -t nat) || fail "failed to read nat rules"
FILTER_RULES=$(sudo iptables-save -t filter) || fail "failed to read filter rules"
IPV6_FILTER_RULES=$(sudo ip6tables-save -t filter) \
  || fail "failed to read IPv6 filter rules"
RAW_RULES=$(sudo iptables-save -t raw) || fail "failed to read raw rules"

PROXY_RULES=$(printf '%s\n' "$NAT_RULES" \
  | grep -E -- "--to-ports? ${PROXY_PORT}([[:space:]]|$)" || true)
[ -n "$PROXY_RULES" ] || fail "generic TCP proxy rules not found"
if printf '%s\n' "$PROXY_RULES" \
  | grep -Fv -- "-m multiport ! --dports 53,853" >/dev/null; then
  fail "generic TCP proxy rule does not exclude ports 53 and 853"
fi

DNS_TCP_RULES=$(printf '%s\n' "$NAT_RULES" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | grep -F -- "-p tcp" \
  | grep -F -- "--dport 53" || true)
[ -n "$DNS_TCP_RULES" ] || fail "TCP/53 dnsmasq redirect rule not found"

printf '%s\n' "$FILTER_RULES" \
  | grep -E -- "-A FORWARD .* -p tcp .*--dport 53 .* -j DROP" >/dev/null \
  || fail "TCP/53 FORWARD drop rule not found"
printf '%s\n' "$FILTER_RULES" \
  | grep -E -- "-A FORWARD .* -p tcp .*--dport 853 .* -j DROP" >/dev/null \
  || fail "TCP/853 FORWARD drop rule not found"

# Verify that source IP is an identity only after the packet arrives on its
# owning host veth. Then inject one namespace's peer IP through another veth
# and prove the raw guard rejects it before the victim DNS rule can attribute it.
mapfile -t RUNNER_NAMESPACES < <(
  printf '%s\n' "$PROXY_RULES" \
    | rule_values --comment \
    | sort -u
)
RUNNER_NAMESPACE_COUNT=${#RUNNER_NAMESPACES[@]}
[ "$RUNNER_NAMESPACE_COUNT" -ge 2 ] \
  || fail "expected at least two runner namespaces, found $RUNNER_NAMESPACE_COUNT"

ATTACKER_NS=${RUNNER_NAMESPACES[0]}
VICTIM_NS=${RUNNER_NAMESPACES[1]}
for namespace in "$ATTACKER_NS" "$VICTIM_NS"; do
  NAMESPACE_PIDS=$(sudo ip netns pids "$namespace") \
    || fail "failed to inspect namespace processes: $namespace"
  [ -z "$NAMESPACE_PIDS" ] \
    || fail "pre-submit namespace unexpectedly active: $namespace"
done
RUNNER_POOL_PREFIX="${ATTACKER_NS%-*}-"
RUNNER_VETH_PREFIX=${RUNNER_POOL_PREFIX/vm0-ns-/vm0-ve-}
ATTACKER_IF=${ATTACKER_NS/vm0-ns-/vm0-ve-}
VICTIM_IF=${VICTIM_NS/vm0-ns-/vm0-ve-}

ATTACKER_POOL_HEX=${ATTACKER_NS#vm0-ns-}
ATTACKER_POOL_HEX=${ATTACKER_POOL_HEX%-*}
ATTACKER_NAMESPACE_HEX=${ATTACKER_NS##*-}
ATTACKER_EXPECTED_ROOT_MAC="02:56:4d:${ATTACKER_POOL_HEX}:${ATTACKER_NAMESPACE_HEX}:01"
ATTACKER_UDEV_PROPERTIES=""
for _ in $(seq 1 100); do
  ATTACKER_UDEV_PROPERTIES=$(sudo udevadm info --query=property \
    --path="/sys/class/net/${ATTACKER_IF}" 2>/dev/null || true)
  if printf '%s\n' "$ATTACKER_UDEV_PROPERTIES" \
    | grep -F -- "ID_NET_LINK_FILE=" >/dev/null; then
    break
  fi
  sleep 0.05
done
ATTACKER_LINK_FILE=$(printf '%s\n' "$ATTACKER_UDEV_PROPERTIES" \
  | sed -n 's/^ID_NET_LINK_FILE=//p' \
  | head -n 1)
[ -n "$ATTACKER_LINK_FILE" ] \
  || fail "udev did not record link processing for $ATTACKER_IF"
ATTACKER_ROOT_MAC=$(sudo ip -j link show dev "$ATTACKER_IF" \
  | jq -r '.[0].address // empty') \
  || fail "failed to read root veth MAC: $ATTACKER_IF"
[ "$ATTACKER_ROOT_MAC" = "$ATTACKER_EXPECTED_ROOT_MAC" ] \
  || fail "root veth MAC changed after udev processing: device=$ATTACKER_IF link_file=$ATTACKER_LINK_FILE expected=$ATTACKER_EXPECTED_ROOT_MAC actual=$ATTACKER_ROOT_MAC"
ATTACKER_ROOT_ADDR_ASSIGN_TYPE=$(sudo cat \
  "/sys/class/net/${ATTACKER_IF}/addr_assign_type") \
  || fail "failed to read root veth address assignment type: $ATTACKER_IF"
[ "$ATTACKER_ROOT_ADDR_ASSIGN_TYPE" = 3 ] \
  || fail "root veth MAC is not userspace-set: device=$ATTACKER_IF addr_assign_type=$ATTACKER_ROOT_ADDR_ASSIGN_TYPE"
echo "PASS: root veth MAC remains stable after udev processing"

ATTACKER_PROXY_RULE=$(printf '%s\n' "$PROXY_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | head -n 1 || true)
VICTIM_PROXY_RULE=$(printf '%s\n' "$PROXY_RULES" \
  | grep -F -- "$VICTIM_NS" \
  | head -n 1 || true)
[ -n "$ATTACKER_PROXY_RULE" ] || fail "attacker proxy rule not found"
[ -n "$VICTIM_PROXY_RULE" ] || fail "victim proxy rule not found"

ATTACKER_CIDR=$(rule_value "$ATTACKER_PROXY_RULE" -s)
VICTIM_CIDR=$(rule_value "$VICTIM_PROXY_RULE" -s)
[ "${ATTACKER_CIDR#*/}" = 32 ] \
  || fail "attacker proxy source is not an exact /32: $ATTACKER_CIDR"
[ "${VICTIM_CIDR#*/}" = 32 ] \
  || fail "victim proxy source is not an exact /32: $VICTIM_CIDR"
[ "$(rule_value "$ATTACKER_PROXY_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "attacker proxy rule is not bound to $ATTACKER_IF"
[ "$(rule_value "$VICTIM_PROXY_RULE" -i)" = "$VICTIM_IF" ] \
  || fail "victim proxy rule is not bound to $VICTIM_IF"
ATTACKER_PEER=${ATTACKER_CIDR%/32}
VICTIM_PEER=${VICTIM_CIDR%/32}

ATTACKER_GUARD_RULE=$(printf '%s\n' "$RAW_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
VICTIM_GUARD_RULE=$(printf '%s\n' "$RAW_RULES" \
  | grep -F -- "$VICTIM_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
[ -n "$ATTACKER_GUARD_RULE" ] || fail "attacker source guard not found"
[ -n "$VICTIM_GUARD_RULE" ] || fail "victim source guard not found"
[ "$(rule_value "$ATTACKER_GUARD_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "attacker source guard is not bound to $ATTACKER_IF"
[ "$(rule_value "$VICTIM_GUARD_RULE" -i)" = "$VICTIM_IF" ] \
  || fail "victim source guard is not bound to $VICTIM_IF"
printf '%s\n' "$ATTACKER_GUARD_RULE" \
  | grep -F -- "! -s ${ATTACKER_CIDR}" >/dev/null \
  || fail "attacker source guard does not reject non-peer sources"
printf '%s\n' "$VICTIM_GUARD_RULE" \
  | grep -F -- "! -s ${VICTIM_CIDR}" >/dev/null \
  || fail "victim source guard does not reject non-peer sources"

ATTACKER_MASQUERADE_RULE=$(printf '%s\n' "$NAT_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A POSTROUTING" \
  | grep -F -- "-j MASQUERADE" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_MASQUERADE_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "host masquerade rule does not use the exact attacker peer"

ATTACKER_OUTBOUND_RULE=$(printf '%s\n' "$FILTER_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A FORWARD" \
  | grep -F -- "-i ${ATTACKER_IF}" \
  | grep -F -- "-j ACCEPT" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_OUTBOUND_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "outbound forwarding rule does not use the exact attacker peer"

ATTACKER_RETURN_RULE=$(printf '%s\n' "$FILTER_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A FORWARD" \
  | grep -F -- "-o ${ATTACKER_IF}" \
  | grep -F -- "-j ACCEPT" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_RETURN_RULE" -d)" = "$ATTACKER_CIDR" ] \
  || fail "return forwarding rule does not use the exact attacker peer"

ATTACKER_LOG_RULE=$(printf '%s\n' "$FILTER_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "VM0:${ATTACKER_PEER}:" \
  | grep -F -- "-j LOG" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_LOG_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "non-TCP log rule is not bound to $ATTACKER_IF"
[ "$(rule_value "$ATTACKER_LOG_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "non-TCP log rule does not use the exact attacker peer"

ATTACKER_DNS_DROP_RULE=$(printf '%s\n' "$FILTER_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_DNS_DROP_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "DNS drop rule is not bound to $ATTACKER_IF"
[ "$(rule_value "$ATTACKER_DNS_DROP_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "DNS drop rule does not use the exact attacker peer"

ATTACKER_DNS_RULE=$(printf '%s\n' "$NAT_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
[ -n "$ATTACKER_DNS_RULE" ] || fail "attacker DNS redirect not found"
[ "$(rule_value "$ATTACKER_DNS_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "attacker DNS redirect is not bound to $ATTACKER_IF"
[ "$(rule_value "$ATTACKER_DNS_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "attacker DNS redirect does not use the exact peer"

VICTIM_DNS_RULE=$(printf '%s\n' "$NAT_RULES" \
  | grep -F -- "$VICTIM_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
[ -n "$VICTIM_DNS_RULE" ] || fail "victim DNS redirect not found"
[ "$(rule_value "$VICTIM_DNS_RULE" -i)" = "$VICTIM_IF" ] \
  || fail "victim DNS redirect is not bound to $VICTIM_IF"
[ "$(rule_value "$VICTIM_DNS_RULE" -s)" = "$VICTIM_CIDR" ] \
  || fail "victim DNS redirect does not use the exact peer"

ATTACKER_GUARD_COUNTED=$(sudo iptables-save -c -t raw \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
ATTACKER_GUARD_BEFORE=$(rule_packet_count "$ATTACKER_GUARD_COUNTED")
[ -n "$ATTACKER_GUARD_BEFORE" ] || fail "source guard counter missing"

ATTACKER_DNS_COUNTED=$(sudo iptables-save -c -t nat \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
ATTACKER_DNS_BEFORE=$(rule_packet_count "$ATTACKER_DNS_COUNTED")
[ -n "$ATTACKER_DNS_BEFORE" ] || fail "attacker DNS redirect counter missing"

ATTACKER_NS_LINK_BEFORE=$(sudo ip -n "$ATTACKER_NS" -j \
  link show dev veth0)
ATTACKER_ROOT_LINK_BEFORE=$(sudo ip -j link show dev "$ATTACKER_IF")
IFS=$'\t' read -r \
  ATTACKER_NS_IFINDEX_BEFORE ATTACKER_NS_LINK_INDEX_BEFORE \
  <<< "$(printf '%s\n' "$ATTACKER_NS_LINK_BEFORE" \
    | link_identity_fields veth0)"
IFS=$'\t' read -r \
  ATTACKER_ROOT_IFINDEX_BEFORE ATTACKER_ROOT_LINK_INDEX_BEFORE \
  <<< "$(printf '%s\n' "$ATTACKER_ROOT_LINK_BEFORE" \
    | link_identity_fields "$ATTACKER_IF")"
if ! { [ "$ATTACKER_NS_IFINDEX_BEFORE" -eq "$ATTACKER_ROOT_LINK_INDEX_BEFORE" ] \
  && [ "$ATTACKER_NS_LINK_INDEX_BEFORE" -eq "$ATTACKER_ROOT_IFINDEX_BEFORE" ]; }; then
  fail "attacker veth peers do not have reciprocal identities"
fi

send_udp_dns_query \
  "$ATTACKER_NS" "$ATTACKER_PEER" "$BEHAVIOR_DNS_DESTINATION"

ATTACKER_DNS_AFTER=""
for _ in $(seq 1 20); do
  ATTACKER_DNS_COUNTED=$(sudo iptables-save -c -t nat \
    | grep -F -- "$ATTACKER_NS" \
    | grep -F -- "-p udp" \
    | grep -F -- "--dport 53" \
    | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
    | head -n 1 || true)
  ATTACKER_DNS_AFTER=$(rule_packet_count "$ATTACKER_DNS_COUNTED")
  if [ -n "$ATTACKER_DNS_AFTER" ] \
    && [ "$ATTACKER_DNS_AFTER" -gt "$ATTACKER_DNS_BEFORE" ]; then
    break
  fi
  sleep 0.05
done

ATTACKER_GUARD_COUNTED=$(sudo iptables-save -c -t raw \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
ATTACKER_GUARD_AFTER_CONTROL=$(rule_packet_count "$ATTACKER_GUARD_COUNTED")

ATTACKER_NS_LINK_AFTER=$(sudo ip -n "$ATTACKER_NS" -j \
  link show dev veth0)
ATTACKER_ROOT_LINK_AFTER=$(sudo ip -j link show dev "$ATTACKER_IF")
IFS=$'\t' read -r \
  ATTACKER_NS_IFINDEX_AFTER ATTACKER_NS_LINK_INDEX_AFTER \
  <<< "$(printf '%s\n' "$ATTACKER_NS_LINK_AFTER" \
    | link_identity_fields veth0)"
IFS=$'\t' read -r \
  ATTACKER_ROOT_IFINDEX_AFTER ATTACKER_ROOT_LINK_INDEX_AFTER \
  <<< "$(printf '%s\n' "$ATTACKER_ROOT_LINK_AFTER" \
    | link_identity_fields "$ATTACKER_IF")"
if ! { [ "$ATTACKER_NS_IFINDEX_AFTER" -eq "$ATTACKER_NS_IFINDEX_BEFORE" ] \
  && [ "$ATTACKER_NS_LINK_INDEX_AFTER" -eq "$ATTACKER_NS_LINK_INDEX_BEFORE" ] \
  && [ "$ATTACKER_ROOT_IFINDEX_AFTER" -eq "$ATTACKER_ROOT_IFINDEX_BEFORE" ] \
  && [ "$ATTACKER_ROOT_LINK_INDEX_AFTER" -eq "$ATTACKER_ROOT_LINK_INDEX_BEFORE" ]; }; then
  fail "attacker veth identity changed during the control query"
fi
if ! { [ "$ATTACKER_NS_IFINDEX_AFTER" -eq "$ATTACKER_ROOT_LINK_INDEX_AFTER" ] \
  && [ "$ATTACKER_NS_LINK_INDEX_AFTER" -eq "$ATTACKER_ROOT_IFINDEX_AFTER" ]; }; then
  fail "attacker veth peers lost reciprocal identities"
fi

[ -n "$ATTACKER_GUARD_AFTER_CONTROL" ] \
  || fail "source guard counter missing after control query"
[ "$ATTACKER_GUARD_AFTER_CONTROL" -eq "$ATTACKER_GUARD_BEFORE" ] \
  || fail "source guard rejected the namespace's assigned peer"
[ -n "$ATTACKER_DNS_AFTER" ] \
  || fail "attacker DNS redirect counter missing after control query"
[ "$ATTACKER_DNS_AFTER" -gt "$ATTACKER_DNS_BEFORE" ] \
  || fail "control query did not reach the attacker DNS redirect: before=$ATTACKER_DNS_BEFORE after=$ATTACKER_DNS_AFTER"

VICTIM_DNS_COUNTED=$(sudo iptables-save -c -t nat \
  | grep -F -- "$VICTIM_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
VICTIM_DNS_BEFORE=$(rule_packet_count "$VICTIM_DNS_COUNTED")
[ -n "$VICTIM_DNS_BEFORE" ] || fail "victim DNS redirect counter missing"

SPOOF_NS=$ATTACKER_NS
SPOOF_IP=$VICTIM_PEER
sudo ip -n "$SPOOF_NS" address add "${SPOOF_IP}/32" dev veth0 \
  || fail "failed to add forged victim source to attacker namespace"
send_udp_dns_query \
  "$SPOOF_NS" "$SPOOF_IP" "$BEHAVIOR_DNS_DESTINATION"

ATTACKER_GUARD_COUNTED=$(sudo iptables-save -c -t raw \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
ATTACKER_GUARD_AFTER_SPOOF=$(rule_packet_count "$ATTACKER_GUARD_COUNTED")
VICTIM_DNS_COUNTED=$(sudo iptables-save -c -t nat \
  | grep -F -- "$VICTIM_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
VICTIM_DNS_AFTER=$(rule_packet_count "$VICTIM_DNS_COUNTED")
cleanup_spoof_address

[ -n "$ATTACKER_GUARD_AFTER_SPOOF" ] \
  || fail "source guard counter missing after forged query"
[ -n "$VICTIM_DNS_AFTER" ] \
  || fail "victim DNS redirect counter missing after forged query"
[ "$ATTACKER_GUARD_AFTER_SPOOF" -gt "$ATTACKER_GUARD_AFTER_CONTROL" ] \
  || fail "source guard did not reject the forged victim source"
[ "$VICTIM_DNS_AFTER" -eq "$VICTIM_DNS_BEFORE" ] \
  || fail "forged source reached the victim DNS attribution rule"
echo "PASS: source identity guard"

DNS_FILTER_COMMENT=$(printf '%s\n' "$FILTER_RULES" \
  | grep -E -- "-A INPUT .*--dport ${DNS_PORT} .*--comment vm0-ns-[0-9a-f]{2}-dns.*-j REJECT" \
  | sed -nE 's/.*--comment "?([^ " ]+)"?.*/\1/p' \
  | head -n 1)
[ -n "$DNS_FILTER_COMMENT" ] || fail "DNS INPUT filter comment missing"
DNS_FILTER_POOL=${DNS_FILTER_COMMENT#vm0-ns-}
DNS_FILTER_POOL=${DNS_FILTER_POOL%-dns}
[ "$RUNNER_POOL_PREFIX" = "vm0-ns-${DNS_FILTER_POOL}-" ] \
  || fail "DNS filter and namespace pool identities differ"
RUNNER_POOL_INDEX=$((16#$DNS_FILTER_POOL))
DNS_FILTER_INTERFACE="vm0-ve-${DNS_FILTER_POOL}-+"

assert_dns_input_filter_family() {
  local family=$1 rules=$2 comment_rules targetless reject protocol
  comment_rules=$(printf '%s\n' "$rules" \
    | grep -F -- "--comment ${DNS_FILTER_COMMENT}" || true)
  [ "$(printf '%s\n' "$comment_rules" | grep -c . || true)" -eq 4 ] \
    || fail "$family DNS INPUT filter expected four rules: $comment_rules"
  [ "$(printf '%s\n' "$comment_rules" \
    | grep -F -c -- "--dport ${DNS_PORT}" || true)" -eq 4 ] \
    || fail "$family DNS INPUT filter does not consistently use port ${DNS_PORT}"
  targetless=$(printf '%s\n' "$comment_rules" | grep -Fv -- " -j " || true)
  reject=$(printf '%s\n' "$comment_rules" | grep -F -- "-j REJECT" || true)
  [ "$(printf '%s\n' "$targetless" | grep -c . || true)" -eq 2 ] \
    || fail "$family DNS INPUT filter expected two targetless rules: $comment_rules"
  [ "$(printf '%s\n' "$reject" | grep -c . || true)" -eq 2 ] \
    || fail "$family DNS INPUT filter expected two REJECT rules: $comment_rules"
  if printf '%s\n' "$targetless" | grep -F -- "! -i" >/dev/null; then
    fail "$family targetless DNS INPUT rule inverted its interface: $targetless"
  fi
  [ "$(printf '%s\n' "$targetless" \
    | grep -F -c -- "-i ${DNS_FILTER_INTERFACE}" || true)" -eq 2 ] \
    || fail "$family targetless DNS INPUT rules do not all match ${DNS_FILTER_INTERFACE}"
  [ "$(printf '%s\n' "$reject" \
    | grep -F -c -- "! -i ${DNS_FILTER_INTERFACE}" || true)" -eq 2 ] \
    || fail "$family DNS INPUT REJECT rules do not all invert ${DNS_FILTER_INTERFACE}"
  for protocol in udp tcp; do
    [ "$(printf '%s\n' "$targetless" | grep -F -c -- "-p ${protocol}" || true)" -eq 1 ] \
      || fail "$family targetless DNS INPUT ${protocol} rule missing or duplicated"
    [ "$(printf '%s\n' "$reject" | grep -F -c -- "-p ${protocol}" || true)" -eq 1 ] \
      || fail "$family DNS INPUT ${protocol} REJECT rule missing or duplicated"
  done
}

assert_dns_input_filter_family IPv4 "$FILTER_RULES"
assert_dns_input_filter_family IPv6 "$IPV6_FILTER_RULES"

DNS_INPUT_UDP_RULE=$(sudo iptables-save -c -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" \
  | grep -F -- "-i ${DNS_FILTER_INTERFACE}" \
  | grep -F -- "-p udp" \
  | grep -Fv -- " -j " \
  | head -n 1 || true)
DNS_INPUT_TCP_RULE=$(sudo iptables-save -c -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" \
  | grep -F -- "-i ${DNS_FILTER_INTERFACE}" \
  | grep -F -- "-p tcp" \
  | grep -Fv -- " -j " \
  | head -n 1 || true)
DNS_INPUT_UDP_BEFORE=$(rule_packet_count "$DNS_INPUT_UDP_RULE")
DNS_INPUT_TCP_BEFORE=$(rule_packet_count "$DNS_INPUT_TCP_RULE")
[ -n "$DNS_INPUT_UDP_BEFORE" ] || fail "IPv4 UDP DNS INPUT counter missing"
[ -n "$DNS_INPUT_TCP_BEFORE" ] || fail "IPv4 TCP DNS INPUT counter missing"

}

exec_network_live_dns() {
# Test 12: verify DNS resolution works inside sandbox
# Uses getent (libc-bin, always available) instead of nslookup (requires dnsutils).
echo "--- Test: DNS resolution ---"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- getent hosts localhost 2>&1) \
  || fail "localhost resolution failed: $OUTPUT"
echo "  localhost: $OUTPUT"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- getent hosts github.com 2>&1) \
  || fail "user DNS resolution failed: $OUTPUT"
echo "  user: $OUTPUT"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --sudo -- getent hosts example.com 2>&1) \
  || fail "root DNS resolution failed: $OUTPUT"
echo "  root: $OUTPUT"

# Force DNS over TCP to a TEST-NET destination with no resolver. A
# valid response proves PREROUTING redirected the connection to the
# runner-managed dnsmasq instead of mitmproxy raw TCP passthrough.
TCP_DNS_SCRIPT="import socket,struct; q=bytes.fromhex('123401000001000000000000077463702d646e7307696e76616c69640000010001'); s=socket.create_connection(('192.0.2.1',53),5); s.sendall(struct.pack('!H',len(q))+q); f=s.makefile('rb'); h=f.read(2); assert len(h)==2; n=struct.unpack('!H',h)[0]; r=f.read(n); assert len(r)==n and r[:2]==q[:2] and r[2]&128; print('TCP_DNS_OK=true')"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- python3 -c "$TCP_DNS_SCRIPT") \
  || fail "TCP DNS resolution failed: $OUTPUT"
[ "$OUTPUT" = "TCP_DNS_OK=true" ] || fail "unexpected TCP DNS output: $OUTPUT"
echo "  tcp: $OUTPUT"

DNS_INPUT_UDP_RULE=$(sudo iptables-save -c -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" \
  | grep -F -- "-i ${DNS_FILTER_INTERFACE}" \
  | grep -F -- "-p udp" \
  | grep -Fv -- " -j " \
  | head -n 1 || true)
DNS_INPUT_TCP_RULE=$(sudo iptables-save -c -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" \
  | grep -F -- "-i ${DNS_FILTER_INTERFACE}" \
  | grep -F -- "-p tcp" \
  | grep -Fv -- " -j " \
  | head -n 1 || true)
DNS_INPUT_UDP_AFTER=$(rule_packet_count "$DNS_INPUT_UDP_RULE")
DNS_INPUT_TCP_AFTER=$(rule_packet_count "$DNS_INPUT_TCP_RULE")
[ "$DNS_INPUT_UDP_AFTER" -gt "$DNS_INPUT_UDP_BEFORE" ] \
  || fail "IPv4 UDP DNS INPUT counter did not increase"
[ "$DNS_INPUT_TCP_AFTER" -gt "$DNS_INPUT_TCP_BEFORE" ] \
  || fail "IPv4 TCP DNS INPUT counter did not increase"


# Default dnsmasq wildcard sockets must still reject requests that
# arrive through a non-runner interface before a TCP handshake or
# DNS response reaches the process. Exercise IPv4/IPv6 and UDP/TCP
# through a temporary, deliberately non-matching veth.
exec {DNS_ISOLATION_LOCK_FD}<>/tmp/vm0-runner-exec-dns-isolation.lock \
  || fail "failed to open DNS isolation lock"
flock -w 30 "$DNS_ISOLATION_LOCK_FD" \
  || fail "timed out waiting for DNS isolation lock"
reclaim_leaked_dns_isolation_fixtures
DNS_ISOLATION_NS="dns-isolation-$$"
DNS_ISOLATION_HOST_IF="vmdh$$"
DNS_ISOLATION_PEER_IF="vmdp$$"
DNS_ISOLATION_HASH=$(printf '%s' "$SVC" | cksum | awk '{print $1}')
DNS_ISOLATION_SECOND=$((18 + DNS_ISOLATION_HASH % 2))
DNS_ISOLATION_THIRD=$(((DNS_ISOLATION_HASH / 2) % 256))
DNS_ISOLATION_BASE=$((((DNS_ISOLATION_HASH / 512) % 64) * 4))
DNS_ISOLATION_HOST_IP="198.${DNS_ISOLATION_SECOND}.${DNS_ISOLATION_THIRD}.$((DNS_ISOLATION_BASE + 1))"
DNS_ISOLATION_PEER_IP="198.${DNS_ISOLATION_SECOND}.${DNS_ISOLATION_THIRD}.$((DNS_ISOLATION_BASE + 2))"
DNS_ISOLATION_IPV6_HEXTET=$(printf '%x' "$((DNS_ISOLATION_HASH % 65535 + 1))")
DNS_ISOLATION_HOST_IPV6="fd00:198:18:${DNS_ISOLATION_IPV6_HEXTET}::1"
DNS_ISOLATION_PEER_IPV6="fd00:198:18:${DNS_ISOLATION_IPV6_HEXTET}::2"

sudo ip netns add "$DNS_ISOLATION_NS" \
  || fail "failed to create DNS isolation namespace"
sudo ip link add "$DNS_ISOLATION_HOST_IF" type veth \
  peer name "$DNS_ISOLATION_PEER_IF" \
  || fail "failed to create DNS isolation veth"
sudo ip link set "$DNS_ISOLATION_PEER_IF" netns "$DNS_ISOLATION_NS"
sudo ip address add "${DNS_ISOLATION_HOST_IP}/30" \
  dev "$DNS_ISOLATION_HOST_IF"
sudo ip -6 address add "${DNS_ISOLATION_HOST_IPV6}/64" \
  dev "$DNS_ISOLATION_HOST_IF" nodad
sudo ip link set "$DNS_ISOLATION_HOST_IF" up
sudo ip -n "$DNS_ISOLATION_NS" address add \
  "${DNS_ISOLATION_PEER_IP}/30" dev "$DNS_ISOLATION_PEER_IF"
sudo ip -n "$DNS_ISOLATION_NS" -6 address add \
  "${DNS_ISOLATION_PEER_IPV6}/64" dev "$DNS_ISOLATION_PEER_IF" nodad
sudo ip -n "$DNS_ISOLATION_NS" link set lo up
sudo ip -n "$DNS_ISOLATION_NS" link set "$DNS_ISOLATION_PEER_IF" up
check_dns_isolation_peer 4 "$DNS_ISOLATION_HOST_IP" "$DNS_ISOLATION_PEER_IP"
check_dns_isolation_peer 6 "$DNS_ISOLATION_HOST_IPV6" "$DNS_ISOLATION_PEER_IPV6"

if ! sudo ip netns exec "$DNS_ISOLATION_NS" \
  python3 - "$DNS_ISOLATION_HOST_IP" "$DNS_ISOLATION_HOST_IPV6" "$DNS_PORT" <<'PY'
import socket
import sys

hosts = sys.argv[1:3]
port = int(sys.argv[3])
query = bytes.fromhex(
    "123401000001000000000000"
    "0d766d302d72656164696e657373"
    "07696e76616c69640000010001"
)

for host in hosts:
    address = (host, port)
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    udp = socket.socket(family, socket.SOCK_DGRAM)
    udp.settimeout(1)
    udp.sendto(query, address)
    try:
        response, _ = udp.recvfrom(4096)
    except (ConnectionError, TimeoutError):
        pass
    else:
        if response:
            raise SystemExit(
                f"dnsmasq answered UDP on non-runner address {host}"
            )
    finally:
        udp.close()

    try:
        tcp = socket.create_connection(address, timeout=1)
    except OSError:
        pass
    else:
        tcp.close()
        raise SystemExit(
            f"dnsmasq TCP port reachable on non-runner address {host}"
        )
PY
then
  fail "dnsmasq accepted a query from a non-runner interface"
fi

sudo ip netns delete "$DNS_ISOLATION_NS" \
  || fail "failed to remove DNS isolation namespace"
sudo ip link delete "$DNS_ISOLATION_HOST_IF" 2>/dev/null || true
DNS_ISOLATION_NS=""
DNS_ISOLATION_HOST_IF=""
exec {DNS_ISOLATION_LOCK_FD}>&-
DNS_ISOLATION_LOCK_FD=""
echo "PASS: DNS resolution"

}

exec_network_stop() {
# Retain the runner's existing pool flock across stop and cleanup assertions.
# The owned Rust guard releases by final close, so pidfd_getfd can preserve the
# same open file description without a handoff window.
RUNNER_MAIN_PID=$(sudo systemctl show "$UNIT" \
  --property=MainPID --value 2>/dev/null) \
  || fail "failed to read runner MainPID before stop"
case "$RUNNER_MAIN_PID" in
  "" | 0 | *[!0-9]*)
    fail "invalid runner MainPID before stop: ${RUNNER_MAIN_PID:-missing}"
    ;;
esac

POOL_LOCK_GUARD_DIR=$(mktemp -d "/tmp/vm0-${SVC}-pool-lock.XXXXXX") \
  || fail "failed to create pool-lock guard directory"
POOL_LOCK_READY="$POOL_LOCK_GUARD_DIR/ready"
POOL_LOCK_RELEASE_FIFO="$POOL_LOCK_GUARD_DIR/release"
POOL_LOCK_ERROR="$POOL_LOCK_GUARD_DIR/error"
POOL_LOCK_HOLDER_STATUS="$POOL_LOCK_GUARD_DIR/holder-status"
POOL_LOCK_PUBLISH_READY="$POOL_LOCK_GUARD_DIR/publish-ready"
POOL_LOCK_PUBLISH_RELEASE="$POOL_LOCK_GUARD_DIR/release-publish"
POOL_LOCK_TARGET="$POOL_LOCK_GUARD_DIR/target"
mkfifo "$POOL_LOCK_RELEASE_FIFO" \
  || fail "failed to create pool-lock release FIFO"
exec {POOL_LOCK_RELEASE_FD}<>"$POOL_LOCK_RELEASE_FIFO" \
  || fail "failed to open pool-lock release FIFO"

# A stable supervisor publishes the privileged helper's terminal status;
# sudo's process identity is not part of the lifecycle protocol.
(
  pool_lock_holder_status=0
  exec {POOL_LOCK_RELEASE_FD}>&-
  sudo python3 - \
    "$RUNNER_MAIN_PID" \
    "$RUNNER_POOL_INDEX" \
    "$POOL_LOCK_READY" \
    "$POOL_LOCK_RELEASE_FIFO" \
    "$POOL_LOCK_TARGET" \
    "$POOL_LOCK_PUBLISH_READY" \
    "$POOL_LOCK_PUBLISH_RELEASE" \
    <<'PY' || pool_lock_holder_status=$?
import ctypes
import errno
import os
import platform
from pathlib import Path
import signal
import sys
import time

runner_pid = int(sys.argv[1])
pool_index = int(sys.argv[2])
ready_path = Path(sys.argv[3])
release_fifo = Path(sys.argv[4])
target_path = Path(sys.argv[5])
publish_ready_path = Path(sys.argv[6])
publish_release_path = Path(sys.argv[7])
lock_name = f"vm0-netns-pool-{pool_index}.lock"


def handle_timeout(_signum, _frame):
    raise TimeoutError("timed out retaining the runner pool lock")


signal.signal(signal.SIGALRM, handle_timeout)
signal.alarm(360)

machine = platform.machine()
if machine not in {"aarch64", "x86_64"}:
    raise RuntimeError(f"unsupported pidfd_getfd architecture: {machine}")

matches = []
for entry in Path(f"/proc/{runner_pid}/fd").iterdir():
    try:
        target = os.readlink(entry)
    except FileNotFoundError:
        continue
    if Path(target).name == lock_name:
        matches.append((int(entry.name), target))

if len(matches) != 1:
    raise RuntimeError(
        f"expected one {lock_name} descriptor on pid {runner_pid}, "
        f"found {len(matches)}"
    )

target_fd, target = matches[0]
pidfd = os.pidfd_open(runner_pid)
try:
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    duplicated_fd = libc.syscall(438, pidfd, target_fd, 0)
    if duplicated_fd < 0:
        error = ctypes.get_errno()
        raise OSError(error, errno.errorcode.get(error, os.strerror(error)))
finally:
    os.close(pidfd)

try:
    if Path(os.readlink(f"/proc/self/fd/{duplicated_fd}")).name != lock_name:
        raise RuntimeError(
            f"duplicated descriptor target changed from {target}"
        )
    release_fd = os.open(release_fifo, os.O_RDONLY)
    try:
        publish_ready_path.touch()
        while not publish_release_path.exists():
            time.sleep(0.05)
        target_path.write_text(target)
        ready_path.touch()
        while os.read(release_fd, 1):
            pass
    finally:
        os.close(release_fd)
finally:
    os.close(duplicated_fd)

signal.alarm(0)
PY
  status_tmp="${POOL_LOCK_HOLDER_STATUS}.tmp.${BASHPID}"
  printf '%s\n' "$pool_lock_holder_status" >"$status_tmp"
  mv "$status_tmp" "$POOL_LOCK_HOLDER_STATUS"
  exit "$pool_lock_holder_status"
) >"$POOL_LOCK_ERROR" 2>&1 &
POOL_LOCK_HOLDER_PID=$!

fail_pool_lock_holder() {
  local status=$1 checkpoint=$2
  [ ! -s "$POOL_LOCK_ERROR" ] || cat "$POOL_LOCK_ERROR"
  fail "pool-lock holder completed with status ${status} ${checkpoint}"
}

fail_if_pool_lock_holder_completed() {
  local checkpoint=$1 status
  if [ -s "$POOL_LOCK_HOLDER_STATUS" ]; then
    status=$(<"$POOL_LOCK_HOLDER_STATUS")
    fail_pool_lock_holder "$status" "$checkpoint"
  fi
}

POOL_LOCK_PUBLISH_ACKNOWLEDGED=false
for _ in $(seq 1 200); do
  [ -e "$POOL_LOCK_READY" ] && break
  fail_if_pool_lock_holder_completed "before retained-lock readiness"
  if [ -e "$POOL_LOCK_PUBLISH_READY" ] \
    && [ "$POOL_LOCK_PUBLISH_ACKNOWLEDGED" = false ]; then
    touch "$POOL_LOCK_PUBLISH_RELEASE"
    POOL_LOCK_PUBLISH_ACKNOWLEDGED=true
  fi
  sleep 0.05
done
if [ ! -e "$POOL_LOCK_READY" ]; then
  fail_if_pool_lock_holder_completed "before retained-lock readiness"
  [ ! -s "$POOL_LOCK_ERROR" ] || cat "$POOL_LOCK_ERROR"
  fail "timed out retaining runner pool lock before stop"
fi
[ "$POOL_LOCK_PUBLISH_ACKNOWLEDGED" = true ] \
  || fail "pool-lock holder skipped delayed readiness"
POOL_LOCK_PATH=$(cat "$POOL_LOCK_TARGET") \
  || fail "failed to read retained pool lock path"
[ -n "$POOL_LOCK_PATH" ] || fail "retained pool lock path is empty"

# Stop transient service (kills sandbox, submit terminates naturally).
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
if sudo flock -n "$POOL_LOCK_PATH" true; then
  fail "pool lock released before cleanup assertions"
else
  POOL_LOCK_PROBE_STATUS=$?
fi
[ "$POOL_LOCK_PROBE_STATUS" -eq 1 ] \
  || fail "failed to probe retained pool lock: status $POOL_LOCK_PROBE_STATUS"
if sudo iptables-save -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" >/dev/null; then
  fail "IPv4 DNS INPUT filter leaked after runner stop"
fi
if sudo ip6tables-save -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" >/dev/null; then
  fail "IPv6 DNS INPUT filter leaked after runner stop"
fi
RAW_RULES_AFTER_STOP=$(sudo iptables-save -t raw) \
  || fail "failed to read raw rules after runner stop"
LEAKED_NAMESPACE_RAW_RULES=$(printf '%s\n' "$RAW_RULES_AFTER_STOP" \
  | grep -F -- "$RUNNER_POOL_PREFIX" || true)
[ -z "$LEAKED_NAMESPACE_RAW_RULES" ] \
  || fail "IPv4 namespace raw rules leaked after runner stop: $LEAKED_NAMESPACE_RAW_RULES"
NAMESPACES_AFTER_STOP=$(sudo ip netns list) \
  || fail "failed to read network namespaces after runner stop"
LEAKED_NAMESPACES=$(printf '%s\n' "$NAMESPACES_AFTER_STOP" \
  | awk -v prefix="$RUNNER_POOL_PREFIX" 'index($1, prefix) == 1') \
  || fail "failed to inspect network namespaces after runner stop"
[ -z "$LEAKED_NAMESPACES" ] \
  || fail "network namespaces leaked after runner stop: $LEAKED_NAMESPACES"
LINKS_AFTER_STOP=$(sudo ip -o link show) \
  || fail "failed to read network links after runner stop"
LEAKED_HOST_VETHS=$(printf '%s\n' "$LINKS_AFTER_STOP" \
  | awk -F ': ' -v prefix="$RUNNER_VETH_PREFIX" '
      {
        name = $2
        sub(/@.*/, "", name)
        if (index(name, prefix) == 1) print name
      }
    ') || fail "failed to inspect network links after runner stop"
[ -z "$LEAKED_HOST_VETHS" ] \
  || fail "host veth devices leaked after runner stop: $LEAKED_HOST_VETHS"

exec {POOL_LOCK_RELEASE_FD}>&-
POOL_LOCK_RELEASE_FD=""
if wait "$POOL_LOCK_HOLDER_PID"; then
  POOL_LOCK_HOLDER_EXIT=0
else
  POOL_LOCK_HOLDER_EXIT=$?
fi
POOL_LOCK_HOLDER_PID=""
if [ "$POOL_LOCK_HOLDER_EXIT" -ne 0 ]; then
  fail_pool_lock_holder \
    "$POOL_LOCK_HOLDER_EXIT" \
    "after releasing retained pool lock"
fi
rm -rf "$POOL_LOCK_GUARD_DIR"
POOL_LOCK_GUARD_DIR=""
POOL_LOCK_HOLDER_STATUS=""
POOL_LOCK_PUBLISH_RELEASE=""
POOL_LOCK_ERROR=""

cleanup_submit_pid "$SUBMIT_PID"
SUBMIT_PID=""
}

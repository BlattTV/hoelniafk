# Networking – one exit IPv4 per identity

```
Windows VM (suite)                      OPNsense                         Exit VPS
10.20.0.101 ─┐  (bind IP of Identity01)                                  eth0: 203.0.113.11 ─▶ Internet
10.20.0.102 ─┼─ LAN ─▶ policy routing ─▶ WireGuard wg0 ═══ tunnel ═══▶  eth0: 203.0.113.12
   …         │          by source IP       (no NAT on the tunnel)          …   (SNAT per source IP)
10.20.0.115 ─┘                                                            eth0: 203.0.113.25
```

The suite opens every Minecraft connection **and** every exit-IP check of an identity from its
configured local source IP (`NetworkProfile.kind = BIND`). The network behind it maps each source
IP to one public IPv4. The suite then verifies that the public IP seen from the internet equals
the *expected public IP* of the profile and can refuse to start sessions on a mismatch
(*Identity settings → Network guard = block*).

Verified by automated tests (LOCAL INTEGRATION): the source address of the Minecraft TCP
connection and of the IP check is the configured bind IP; SOCKS5 and HTTP-CONNECT proxies are
used with their vault credentials; a wrong exit is detected; guarded sessions never connect
with a wrong exit (`tests/integration/network.int.test.ts`, `runtime.int.test.ts`).

## 1. Windows: additional source IPs

Add one IPv4 per identity to the VM's adapter, **with `SkipAsSource`** so Windows itself keeps
using its primary address and only the suite uses the extra ones explicitly.

```powershell
# as Administrator – adapter name from Get-NetAdapter
powershell -ExecutionPolicy Bypass -File scripts\windows\add-bind-ips.ps1 -Adapter "Ethernet" -Prefix "10.20.0" -From 101 -To 115 -PrefixLength 24
Get-NetIPAddress -AddressFamily IPv4 | ft IPAddress, SkipAsSource, InterfaceAlias
```

Manual alternative: `New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.20.0.101 -PrefixLength 24 -SkipAsSource $true`.
(With a DHCP-configured adapter, switch it to a static primary address first.)

In the suite: *Identity → Network → Add profile* → kind **Local bind IP**, bind IP `10.20.0.101`,
expected public IP `203.0.113.11`, label `IP #01`. Per-session overrides are possible in the
server assignment table (only profiles of the same identity can be selected).

## 2. OPNsense: policy routing by source IP into the tunnel

1. **VPN → WireGuard**: create the instance (e.g. `wg0`, tunnel address `10.99.0.2/30`) and the
   peer (Exit VPS endpoint, public key, *Allowed IPs* `0.0.0.0/0`). Enable.
2. **Interfaces → Assignments**: assign `wg0` (e.g. `WG_EXIT`), enable, no IP config needed.
3. **System → Gateways**: add gateway `WG_EXIT_GW` on `WG_EXIT`, IP = VPS tunnel address
   (`10.99.0.1`), *Far gateway* enabled, monitoring IP `10.99.0.1`.
4. **Firewall → Aliases**: alias `HOELNI_SOURCES` = `10.20.0.101-10.20.0.115`.
5. **Firewall → Rules → LAN**: rule *pass, source `HOELNI_SOURCES`, destination any, Gateway
   `WG_EXIT_GW`* – place it above the default LAN rule.
6. **Kill switch**: directly below, *block, source `HOELNI_SOURCES`, destination any* (so these
   addresses never leave via the normal WAN if the tunnel is down). In *Firewall → Settings →
   Advanced* **disable** "Skip rules when gateway is down" so the policy rule does not silently fall
   back to the default route.
7. **Firewall → NAT → Outbound**: hybrid mode; add *Do not NAT* for source `HOELNI_SOURCES` on
   interface `WG_EXIT` – the VPS must see the original source addresses to map them.
8. DNS: the suite resolves server names through Windows; if you want DNS through the tunnel as
   well, point the VM's DNS to a resolver reachable via the tunnel.

## 3. Exit VPS: one public IPv4 per source IP

The VPS needs several public IPv4 addresses routed to it by the provider (additional/failover IPs).

```bash
# /etc/wireguard/wg0.conf on the VPS
[Interface]
Address = 10.99.0.1/30
ListenPort = 51820
PrivateKey = <vps-private-key>
PostUp = sysctl -w net.ipv4.ip_forward=1

[Peer]  # OPNsense
PublicKey = <opnsense-public-key>
AllowedIPs = 10.99.0.2/32, 10.20.0.0/24     # the LAN source range must be routed back through the tunnel
```

Add the public addresses to the WAN interface (netplan example):

```yaml
network:
  ethernets:
    eth0:
      addresses: [203.0.113.11/32, 203.0.113.12/32, 203.0.113.13/32]   # … one per identity
```

SNAT per source address (iptables; nftables equivalent works the same way):

```bash
for i in $(seq 1 15); do
  src=10.20.0.$((100 + i)); pub=203.0.113.$((10 + i))
  iptables -t nat -A POSTROUTING -s $src -o eth0 -j SNAT --to-source $pub
done
iptables -A FORWARD -i wg0 -o eth0 -s 10.20.0.0/24 -j ACCEPT
iptables -A FORWARD -i eth0 -o wg0 -m state --state ESTABLISHED,RELATED -j ACCEPT
# persist: iptables-save > /etc/iptables/rules.v4  (package iptables-persistent)
```

Alternative with one tunnel per identity: one WireGuard instance/gateway per identity on
OPNsense and one SNAT rule per tunnel on the VPS. More configuration, but a broken tunnel only
affects one identity.

## 4. Verify

1. In the suite: *Identity → Network → Diagnose*. Expected steps:
   `Profile ✓ · Local bind IP ✓ (assigned to a local interface) · DNS ✓ · Minecraft TCP ✓ (local
   source 10.20.0.101) · Public exit IP ✓ (203.0.113.11 = expected) · Isolation ✓`.
2. Bulk: *Identities → select all → Verify Network*.
3. Set *Network guard* to `block` in the template/identities so a wrong exit never connects.
4. The Minecraft server can confirm it: the join IP of each player is its exit IP.

The public-IP check uses `network.ipEndpoints` (api.ipify.org, ifconfig.me, icanhazip.com by
default) – they must be reachable through the tunnel.

## 5. Proxies instead of bind IPs

Profiles can also use **SOCKS5** (username/password) or **HTTP CONNECT** proxies (Basic auth);
passwords are stored in the vault. A bind IP can be combined with a proxy (the connection to the
proxy is made from the bind IP).

## 6. Troubleshooting

| Diagnosis step | Meaning / fix |
|---|---|
| Local bind IP ✗ "not assigned to any local network interface" | add the address on Windows (section 1); check the adapter name |
| Minecraft TCP ✗ `EADDRNOTAVAIL` | the bind IP is not on this machine / wrong adapter |
| Minecraft TCP ✗ timeout | OPNsense rule order, tunnel down, kill switch blocking (tunnel down) |
| Public exit IP ✗ mismatch | wrong SNAT mapping on the VPS or two identities share a source → check the *Isolation* step |
| Public exit IP ✗ check failed | IP endpoints not reachable through the tunnel; DNS; VPS forwarding |
| Isolation ⚠ "shares expectedPublicIp" | two identities are configured for the same exit – fix the profiles (PER_ACCOUNT mode) |
| Works, but after a VPS reboot everything is RECONNECTING with "Network guard" | SNAT rules / IPs not persistent on the VPS |

`netstat -ano | findstr :25565` on Windows shows the local source address of each connection.

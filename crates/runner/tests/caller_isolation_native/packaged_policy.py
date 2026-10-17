from policy import CAP, CLASSES, FILE, SOCKET


def build_policy():
    classes = {
        **CLASSES,
        "cap_userns": CAP,
        "cap2_userns": CLASSES["capability2"],
        "netlink_route_socket": SOCKET + " nlmsg_read nlmsg_write",
        "netlink_audit_socket": SOCKET
        + " nlmsg_read nlmsg_write nlmsg_relay nlmsg_readpriv nlmsg_tty_audit",
    }
    types = [
        "control_t",
        "agent_t",
        "workload_t",
        "toolbridge_t",
        "taskbridge_t",
        "toolbridge_exec_t",
        "taskbridge_exec_t",
        "workload_shell_exec_t",
        "workload_data_t",
        "model_port_t",
        "ordinary_port_t",
        "cgroup_t",
        "gateway_key_t",
        "runtime_log_t",
        "resource_anchor_t",
        "resource_config_t",
        "agent_state_t",
        "runtime_state_t",
    ]
    lines = ["(handleunknown deny)", "(mls false)"]
    lines += [f"(class {k} ({v}))" for k, v in classes.items()]
    lines += [f"(classorder ({' '.join(classes)}))"]
    sids = [
        "kernel",
        "security",
        "unlabeled",
        "fs",
        "file",
        "file_labels",
        "init",
        "any_socket",
        "port",
        "netif",
        "netmsg",
        "node",
    ]
    lines += [f"(sid {s})" for s in sids] + [f"(sidorder ({' '.join(sids)}))"]
    lines += [
        "(user system_u)",
        "(role system_r)",
        "(role object_r)",
        "(sensitivity s0)",
        "(sensitivityorder (s0))",
        "(userlevel system_u (s0))",
        "(userrange system_u ((s0) (s0)))",
        "(userrole system_u system_r)",
        "(userrole system_u object_r)",
    ]
    for t in types:
        lines += [f"(type {t})", f"(roletype system_r {t})", f"(roletype object_r {t})"]
    lines += [
        "(typeattribute all_types)",
        f"(typeattributeset all_types ({' '.join(types)}))",
    ]
    for s in sids:
        lines += [f"(sidcontext {s} (system_u system_r control_t ((s0) (s0))))"]
    for k, v in classes.items():
        lines += [f"(allow control_t all_types ({k} ({v})))"]
    lines += [
        "(fsuse xattr ext4 (system_u object_r control_t ((s0) (s0))))",
        "(fsuse xattr tmpfs (system_u object_r control_t ((s0) (s0))))",
        "(genfscon cgroup2 / (system_u object_r cgroup_t ((s0) (s0))))",
        "(allow all_types all_types (filesystem (associate)))",
    ]
    for source in [
        "control_t",
        "agent_t",
        "workload_t",
        "toolbridge_t",
        "taskbridge_t",
    ]:
        for kind in ["file", "dir", "lnk_file", "fifo_file", "sock_file"]:
            lines += [
                f"(typetransition {source} workload_data_t {kind} workload_data_t)"
            ]
            lines += [
                f"(typetransition {source} resource_anchor_t {kind} workload_data_t)"
            ]
    for r in ["agent_t", "workload_t", "toolbridge_t", "taskbridge_t"]:
        lines += [
            f"(allow {r} self (process (fork sigchld getattr getcap getrlimit setrlimit getsched setsched getpgid setpgid getsession signal sigkill sigstop signull execmem)))",
            f"(allow {r} control_t (process (sigchld)))",
            f"(allow {r} all_types (process (sigchld)))",
            f"(allow {r} all_types (fd (use)))",
            f"(allow {r} control_t (filesystem (getattr)))",
            f"(allow {r} control_t (blk_file (getattr)))",
            f"(allow {r} control_t (file (ioctl)))",
            f"(allowx {r} control_t (ioctl file (0x5401 0x5413)))",
            f"(allow {r} self (netlink_route_socket ({SOCKET} nlmsg_read)))",
            f"(allow {r} self (netlink_audit_socket ({SOCKET} nlmsg_relay)))",
            f"(allow {r} control_t (association (sendto recvfrom)))",
            f"(allow {r} control_t (node (sendto recvfrom)))",
            f"(allow {r} self (tcp_socket ({SOCKET} node_bind)))",
            f"(allow {r} self (udp_socket ({SOCKET} node_bind)))",
            f"(allow {r} self (unix_stream_socket ({SOCKET} connectto)))",
            f"(allow {r} control_t (unix_stream_socket (connectto read write)))",
            f"(allow {r} agent_t (unix_stream_socket (read write getattr getopt shutdown ioctl)))",
            f"(allow {r} workload_t (unix_stream_socket (read write getattr getopt shutdown ioctl)))",
            f"(allow {r} self (unix_dgram_socket ({SOCKET})))",
            f"(allow {r} self (file (open read write getattr ioctl)))",
            f"(allow {r} self (lnk_file (read getattr)))",
            f"(allow {r} self (dir (open read getattr search)))",
            f"(allow {r} self (capability (setuid setgid)))",
            f"(allow {r} all_types (dir (open read getattr search)))",
            f"(allow {r} resource_anchor_t (dir (write add_name remove_name)))",
        ]
        for t in [
            "control_t",
            "toolbridge_exec_t",
            "taskbridge_exec_t",
            "workload_shell_exec_t",
        ]:
            lines += [
                f"(allow {r} {t} (file (open read getattr execute execute_no_trans map watch)))",
                f"(allow {r} {t} (lnk_file (read getattr)))",
            ]
        lines += [
            f"(allow {r} control_t (chr_file (open read write getattr ioctl)))",
            f"(allow {r} control_t (fifo_file (open read write getattr ioctl)))",
            f"(allow {r} agent_t (fifo_file (read write getattr ioctl)))",
            f"(allow {r} workload_t (fifo_file (read write getattr ioctl)))",
            f"(allow {r} workload_data_t (file (open read write append create getattr setattr lock ioctl map unlink link rename)))",
            f"(allow {r} workload_data_t (dir ({FILE} add_name remove_name search rmdir reparent)))",
            f"(allow {r} workload_data_t (lnk_file ({FILE})))",
            f"(allow {r} workload_data_t (fifo_file ({FILE})))",
            f"(allow {r} workload_data_t (sock_file ({FILE})))",
            f"(allow {r} cgroup_t (file (open read write getattr)))",
            f"(allow {r} runtime_log_t (file (write append getattr ioctl)))",
            f"(allow {r} ordinary_port_t (tcp_socket (name_connect)))",
        ]
    # Ordinary execution does not gain a protected role from mutable binaries.
    safe_caps = "chown dac_override dac_read_search fowner fsetid kill setgid setuid setpcap net_bind_service sys_chroot sys_resource audit_write setfcap mknod"
    lines += [
        "(typetransition workload_t control_t file workload_data_t)",
        "(typetransition agent_t runtime_state_t file runtime_state_t)",
        "(typetransition agent_t runtime_state_t dir runtime_state_t)",
        "(typetransition agent_t runtime_state_t lnk_file runtime_state_t)",
        "(allow agent_t runtime_state_t (file (create open read write append getattr setattr lock map unlink rename watch)))",
        "(allow agent_t runtime_state_t (dir (create open read write getattr setattr add_name remove_name search rename rmdir)))",
        "(allow agent_t runtime_state_t (lnk_file (create read write getattr setattr unlink rename)))",
        # Upstream locks even credential/settings reads. Permit only these
        # named lock directories and the private credential file, while fixed
        # executable discovery files/directories retain immutable labels.
        '(typetransition agent_t resource_config_t dir "auth.json.lock" agent_state_t)',
        '(typetransition agent_t resource_config_t dir "settings.json.lock" agent_state_t)',
        "(allow agent_t resource_config_t (dir (write add_name remove_name)))",
        "(allow agent_t agent_state_t (file (open read write append getattr setattr lock)))",
        "(allow agent_t agent_state_t (dir (create open read write getattr setattr add_name remove_name search rmdir)))",
        f"(allow workload_t self (capability ({safe_caps})))",
        f"(allow workload_t self (cap_userns ({safe_caps} sys_admin sys_ptrace)))",
        "(allow workload_t self (process (ptrace)))",
        "(allow workload_t self (process (setcap)))",
        "(allow workload_t self (user_namespace (create)))",
        "(allow workload_t control_t (tcp_socket (node_bind)))",
        "(allow workload_t ordinary_port_t (tcp_socket (name_bind)))",
        "(allow workload_t workload_data_t (file (execute execute_no_trans entrypoint execmod)))",
        "(allow agent_t model_port_t (tcp_socket (name_connect)))",
        "(allow agent_t self (process (setcurrent)))",
        "(allow agent_t workload_t (process (dyntransition transition siginh rlimitinh noatsecure)))",
        "(typetransition agent_t workload_shell_exec_t process workload_t)",
        "(allow workload_t workload_shell_exec_t (file (entrypoint)))",
    ]
    for source, bridge in [
        ("agent_t", "toolbridge"),
        ("workload_t", "toolbridge"),
        ("agent_t", "taskbridge"),
        ("workload_t", "taskbridge"),
    ]:
        lines += [
            f"(typetransition {source} {bridge}_exec_t process {bridge}_t)",
            f"(allow {source} {bridge}_t (process (transition siginh rlimitinh noatsecure)))",
            f"(allow {bridge}_t {bridge}_exec_t (file (entrypoint)))",
        ]
    for bridge, target in [("toolbridge_t", "workload_t"), ("taskbridge_t", "agent_t")]:
        lines += [
            f"(allow {bridge} self (capability (sys_admin sys_chroot setuid setgid)))",
            f"(allow {bridge} self (process (setcurrent setcap)))",
            f"(allow {bridge} {target} (process (dyntransition)))",
            f"(allow {bridge} control_t (file (ioctl)))",
            f"(allowx {bridge} control_t (ioctl file (0xb703)))",
            f"(allow {bridge} control_t (filesystem (mount)))",
        ]
    lines += ["(allow taskbridge_t workload_t (process (dyntransition)))"]
    lines += [
        "(portcon tcp (18080 18080) (system_u object_r model_port_t ((s0) (s0))))",
        "(portcon tcp (18081 65535) (system_u object_r ordinary_port_t ((s0) (s0))))",
    ]
    return "\n".join(lines) + "\n"

"""Fixture policy only; never installed in a production Guest."""

FILE = "ioctl read write create getattr setattr lock relabelfrom relabelto append map unlink link rename execute quotaon mounton audit_access open execmod watch watch_mount watch_sb watch_with_perm watch_reads watch_mountns"
SOCKET = "ioctl read write create getattr setattr lock relabelfrom relabelto append map bind connect listen accept getopt setopt shutdown recvfrom sendto name_bind"
CAP = "chown dac_override dac_read_search fowner fsetid kill setgid setuid setpcap linux_immutable net_bind_service net_broadcast net_admin net_raw ipc_lock ipc_owner sys_module sys_rawio sys_chroot sys_ptrace sys_pacct sys_admin sys_boot sys_nice sys_resource sys_time sys_tty_config mknod lease audit_write audit_control setfcap"
CLASSES = {
    "security": "compute_av compute_create compute_member check_context load_policy compute_relabel compute_user setenforce setbool setsecparam setcheckreqprot read_policy validate_trans",
    "process": "fork transition sigchld sigkill sigstop signull signal ptrace getsched setsched getsession getpgid setpgid getcap setcap share getattr setexec setfscreate noatsecure siginh setrlimit rlimitinh dyntransition setcurrent execmem execstack execheap setkeycreate setsockcreate getrlimit",
    "process2": "nnp_transition nosuid_transition",
    "system": "ipc_info syslog_read syslog_mod syslog_console module_request module_load firmware_load kexec_image_load kexec_initramfs_load policy_load x509_certificate_load",
    "capability": CAP,
    "capability2": "mac_override mac_admin syslog wake_alarm block_suspend audit_read perfmon bpf checkpoint_restore",
    "filesystem": "mount remount unmount getattr relabelfrom relabelto associate quotamod quotaget watch",
    "file": FILE + " execute_no_trans entrypoint",
    "dir": FILE + " add_name remove_name reparent search rmdir",
    "fd": "use",
    **{
        name: FILE
        for name in ("lnk_file", "chr_file", "blk_file", "sock_file", "fifo_file")
    },
    "tcp_socket": SOCKET + " node_bind name_connect",
    "udp_socket": SOCKET + " node_bind",
    "rawip_socket": SOCKET + " node_bind",
    "unix_stream_socket": SOCKET + " connectto",
    "unix_dgram_socket": SOCKET,
    "node": "recvfrom sendto",
    "netif": "ingress egress",
    "packet": "send recv relabelto forward_in forward_out",
    "association": "sendto recvfrom setcontext polmatch",
    "user_namespace": "create",
}
TYPES = (
    "control_t",
    "agent_t",
    "workload_t",
    "gateway_t",
    "protected_file_t",
    "gateway_key_t",
    "workload_data_t",
    "model_port_t",
    "ordinary_port_t",
)


def build_policy():
    lines = ["(handleunknown deny)", "(mls false)"]
    lines += [f"(class {name} ({perms}))" for name, perms in CLASSES.items()]
    lines += [f"(classorder ({' '.join(CLASSES)}))"]
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
    lines += [f"(sid {name})" for name in sids]
    lines += [f"(sidorder ({' '.join(sids)}))"]
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
    for name in TYPES:
        lines += [
            f"(type {name})",
            f"(roletype system_r {name})",
            f"(roletype object_r {name})",
        ]
    lines += [
        "(typeattribute fixture_types)",
        f"(typeattributeset fixture_types ({' '.join(TYPES)}))",
    ]
    context = "(system_u system_r control_t ((s0) (s0)))"
    for sid in sids:
        lines.append(f"(sidcontext {sid} {context})")
    lines += [
        f"(allow control_t fixture_types ({name} ({perms})))"
        for name, perms in CLASSES.items()
    ]
    lines += ["(fsuse xattr tmpfs (system_u object_r control_t ((s0) (s0))))"]
    lines += ["(allow fixture_types control_t (filesystem (associate)))"]
    for role in ("agent_t", "workload_t", "gateway_t"):
        lines += [f"(allow {role} control_t (association (sendto recvfrom)))"]
        lines += [f"(allow {role} control_t (lnk_file (read getattr)))"]
        lines += [f"(allow {role} control_t (tcp_socket (node_bind)))"]
        lines += [f"(allow {role} self (udp_socket (create ioctl)))"]
        lines += [
            f"(allow {role} self (file (open read write getattr)))",
            f"(allow {role} self (dir (search open read getattr)))",
        ]
        lines += [
            f"(allow {role} self (process (fork sigchld getattr getcap getrlimit)))",
            f"(allow {role} self (capability (setuid setgid)))",
            f"(allow {role} control_t (fd (use)))",
            f"(allow {role} control_t (fifo_file (write read getattr)))",
            f"(allow {role} control_t (dir (search read open getattr)))",
            f"(allow {role} control_t (file (read open getattr)))",
            f"(allow {role} control_t (process (sigchld)))",
            f"(allow {role} self (tcp_socket ({SOCKET} node_bind)))",
            f"(allow {role} control_t (node (sendto recvfrom)))",
        ]
    lines += [
        "(allow agent_t self (process (setcurrent)))",
        "(allow agent_t workload_t (process (dyntransition)))",
        "(allow agent_t model_port_t (tcp_socket (name_connect)))",
        "(allow gateway_t model_port_t (tcp_socket (name_bind)))",
        "(allow workload_t ordinary_port_t (tcp_socket (name_connect name_bind)))",
        "(allow workload_t workload_data_t (file (open read write getattr)))",
        "(allow workload_t workload_data_t (dir (search read open getattr)))",
        "(allow agent_t protected_file_t (file (open read getattr map)))",
        "(allow gateway_t gateway_key_t (file (open read getattr)))",
        "(portcon tcp (18080 18080) (system_u object_r model_port_t ((s0) (s0))))",
        "(portcon tcp (18081 18081) (system_u object_r ordinary_port_t ((s0) (s0))))",
    ]
    return "\n".join(lines) + "\n"

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/capability.h>
#include <linux/reboot.h>
#include <net/if.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/ptrace.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>

static unsigned failures;
static unsigned cases;
static int protected_key_fd = -1;

static void deadline(int number) {
    (void)number;
    const char message[] = "OKOU_CALLER_FATAL {\"operation\":\"guest_deadline\",\"errno\":110}\n";
    ssize_t ignored = write(STDOUT_FILENO, message, sizeof(message) - 1);
    (void)ignored;
    reboot(LINUX_REBOOT_CMD_RESTART);
    _exit(124);
}

static void fatal(const char *operation) {
    printf("OKOU_CALLER_FATAL {\"operation\":\"%s\",\"errno\":%d}\n", operation, errno);
    fflush(stdout);
    reboot(LINUX_REBOOT_CMD_RESTART);
    _exit(1);
}

static void write_all(int fd, const void *buffer, size_t length) {
    const char *p = buffer;
    while (length) {
        ssize_t n = write(fd, p, length);
        if (n < 0 && errno == EINTR)
            continue;
        if (n <= 0)
            fatal("write_all");
        p += n;
        length -= (size_t)n;
    }
}

static void read_all(int fd, void *buffer, size_t length) {
    char *p = buffer;
    while (length) {
        ssize_t n = read(fd, p, length);
        if (n < 0 && errno == EINTR)
            continue;
        if (n == 0) {
            errno = EPIPE;
            fatal("read_all_eof");
        }
        if (n < 0)
            fatal("read_all");
        p += n;
        length -= (size_t)n;
    }
}

static void text_file(const char *path, const char *text) {
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0)
        fatal(path);
    write_all(fd, text, strlen(text));
    if (close(fd))
        fatal("close_text_file");
}

static void role(const char *name) {
    char context[128];
    snprintf(context, sizeof(context), "system_u:system_r:%s", name);
    text_file("/proc/self/attr/current", context);
}

static int enforcing(void) {
    char c = 0;
    int fd = open("/sys/fs/selinux/enforce", O_RDONLY);
    if (fd < 0 || read(fd, &c, 1) != 1)
        fatal("read_enforce");
    close(fd);
    return c == '1';
}

static void label(const char *path, const char *name) {
    char context[128];
    snprintf(context, sizeof(context), "system_u:object_r:%s", name);
    if (setxattr(path, "security.selinux", context, strlen(context) + 1, 0))
        fatal("label_fixture");
}

static void create_file(const char *path, const char *type) {
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0)
        fatal("create_fixture_file");
    write_all(fd, "public-synthetic-fixture\n", 25);
    close(fd);
    if (chmod(path, 0666))
        fatal("chmod_fixture");
    label(path, type);
}

static int connect_port(unsigned port) {
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0)
        return -1;
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(port)};
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr))) {
        int error = errno;
        close(fd);
        errno = error;
        return -1;
    }
    return fd;
}

static pid_t server(unsigned port, const char *domain) {
    int ready[2];
    if (pipe2(ready, O_CLOEXEC))
        fatal("server_pipe");
    pid_t pid = fork();
    if (pid < 0)
        fatal("server_fork");
    if (!pid) {
        close(ready[0]);
        if (domain)
            role(domain);
        int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
        struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(port)};
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (fd < 0 || bind(fd, (struct sockaddr *)&addr, sizeof(addr)) || listen(fd, 8))
            fatal("server_listen");
        write_all(ready[1], "1", 1);
        close(ready[1]);
        for (;;) {
            int peer = accept4(fd, NULL, NULL, SOCK_CLOEXEC);
            if (peer < 0) {
                if (errno == EINTR)
                    continue;
                fatal("server_accept");
            }
            char byte;
            if (read(peer, &byte, 1) == 1) {
                ssize_t ignored = write(peer, "1", 1);
                (void)ignored;
            }
            close(peer);
        }
    }
    close(ready[1]);
    char byte;
    read_all(ready[0], &byte, 1);
    close(ready[0]);
    return pid;
}

enum action {
    MODEL_CONNECT,
    ORDINARY_CONNECT,
    MODEL_BIND,
    PROTECTED_WRITE,
    KEY_READ,
    DATA_WRITE,
    DISABLE_POLICY,
    RELABEL,
    RAW_SOCKET,
    MOUNT,
    PROCESS_MEMORY,
    FORGE_ROLE,
    INHERITED_SOCKET,
    STEAL_KEY_FD,
    INHERITED_KEY,
    NETWORK_CONTROL
};

static int open_then_close(const char *path, int flags) {
    int fd = open(path, flags | O_CLOEXEC);
    if (fd < 0)
        return -1;
    close(fd);
    return 0;
}

static int operation(enum action action, int inherited) {
    switch (action) {
    case MODEL_CONNECT:
    case ORDINARY_CONNECT: {
        int fd = connect_port(action == MODEL_CONNECT ? 18080 : 18081);
        if (fd < 0)
            return -1;
        char byte;
        int result = write(fd, "1", 1) == 1 && read(fd, &byte, 1) == 1 && byte == '1' ? 0 : -1;
        int error = errno;
        close(fd);
        errno = error;
        return result;
    }
    case MODEL_BIND: {
        int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if (fd < 0)
            return -1;
        struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(18080)};
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        int result = bind(fd, (struct sockaddr *)&addr, sizeof(addr));
        int error = errno;
        close(fd);
        errno = error;
        return result;
    }
    case PROTECTED_WRITE:
        return open_then_close("/fixture/protected", O_WRONLY);
    case KEY_READ: {
        int fd = open("/fixture/key", O_RDONLY | O_CLOEXEC);
        if (fd < 0)
            return -1;
        char byte;
        ssize_t count = read(fd, &byte, 1);
        int error = count < 0 ? errno : EIO;
        close(fd);
        errno = error;
        return count == 1 ? 0 : -1;
    }
    case DATA_WRITE: {
        int fd = open("/fixture/data", O_WRONLY | O_APPEND | O_CLOEXEC);
        if (fd < 0)
            return -1;
        ssize_t count = write(fd, "1", 1);
        int error = count < 0 ? errno : EIO;
        close(fd);
        errno = error;
        return count == 1 ? 0 : -1;
    }
    case DISABLE_POLICY: {
        int fd = open("/sys/fs/selinux/enforce", O_WRONLY | O_CLOEXEC);
        if (fd < 0)
            return -1;
        ssize_t result = write(fd, "0", 1);
        int error = errno;
        close(fd);
        errno = error;
        return result == 1 ? 0 : -1;
    }
    case RELABEL: {
        const char *context = "system_u:object_r:gateway_key_t";
        return setxattr("/fixture/data", "security.selinux", context, strlen(context) + 1, 0);
    }
    case RAW_SOCKET: {
        int fd = socket(AF_INET, SOCK_RAW | SOCK_CLOEXEC, IPPROTO_ICMP);
        if (fd < 0)
            return -1;
        close(fd);
        return 0;
    }
    case MOUNT:
        return mount("none", "/fixture/mount", "tmpfs", MS_NOSUID | MS_NODEV, "size=1m");
    case PROCESS_MEMORY:
        return open_then_close("/proc/1/mem", O_RDONLY);
    case FORGE_ROLE: {
        int fd = open("/proc/self/attr/current", O_WRONLY | O_CLOEXEC);
        if (fd < 0)
            return -1;
        const char *context = "system_u:system_r:agent_t";
        ssize_t result = write(fd, context, strlen(context));
        int error = errno;
        close(fd);
        errno = error;
        return result == (ssize_t)strlen(context) ? 0 : -1;
    }
    case INHERITED_SOCKET:
        return write(inherited, "1", 1) == 1 ? 0 : -1;
    case STEAL_KEY_FD: {
        char path[80];
        snprintf(path, sizeof(path), "/proc/1/fd/%d", protected_key_fd);
        return open_then_close(path, O_RDONLY);
    }
    case INHERITED_KEY: {
        char byte;
        return read(protected_key_fd, &byte, 1) == 1 ? 0 : -1;
    }
    case NETWORK_CONTROL: {
        int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
        if (fd < 0)
            return -1;
        struct ifreq interface = {0};
        strcpy(interface.ifr_name, "lo");
        int result = ioctl(fd, SIOCGIFFLAGS, &interface);
        if (!result)
            result = ioctl(fd, SIOCSIFFLAGS, &interface);
        int error = errno;
        close(fd);
        errno = error;
        return result;
    }
    }
    errno = EINVAL;
    return -1;
}

struct result {
    int result, error;
    uid_t uid;
    uint64_t capabilities;
    char context[128];
};

static void test(const char *name, const char *domain, uid_t uid, enum action action,
                 bool allowed) {
    int channel[2];
    if (pipe2(channel, O_CLOEXEC))
        fatal("test_pipe");
    pid_t pid = fork();
    if (pid < 0)
        fatal("test_fork");
    if (!pid) {
        close(channel[0]);
        role(action == INHERITED_SOCKET ? "agent_t" : domain);
        int inherited = -1;
        if (action == INHERITED_SOCKET) {
            inherited = connect_port(18080);
            if (inherited < 0)
                fatal("inherited_socket_setup");
            role(domain);
        }
        if (setgid(uid) || setuid(uid))
            fatal("set_workload_uid");
        struct result result = {.uid = getuid()};
        struct __user_cap_header_struct cap_header = {.version = _LINUX_CAPABILITY_VERSION_3};
        struct __user_cap_data_struct cap_data[2] = {0};
        if (syscall(SYS_capget, &cap_header, cap_data))
            fatal("read_capabilities");
        result.capabilities = ((uint64_t)cap_data[1].effective << 32) | cap_data[0].effective;
        int context = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC);
        if (context < 0)
            fatal("read_context");
        ssize_t n = read(context, result.context, sizeof(result.context) - 1);
        close(context);
        if (n <= 0)
            fatal("read_context_bytes");
        result.context[strcspn(result.context, "\n")] = 0;
        errno = 0;
        result.result = operation(action, inherited);
        result.error = result.result < 0 ? errno : 0;
        if (inherited >= 0)
            close(inherited);
        write_all(channel[1], &result, sizeof(result));
        close(channel[1]);
        _exit(0);
    }
    close(channel[1]);
    struct result result;
    read_all(channel[0], &result, sizeof(result));
    close(channel[0]);
    int status;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) || WEXITSTATUS(status))
        fatal("test_exit");
    char expected[128];
    snprintf(expected, sizeof(expected), "system_u:system_r:%s", domain);
    bool passed =
        result.uid == uid && !strcmp(result.context, expected) &&
        (allowed ? result.result == 0
                 : result.result == -1 && (result.error == EACCES || result.error == EPERM));
    uint64_t root_capabilities = (UINT64_C(1) << CAP_SYS_ADMIN) | (UINT64_C(1) << CAP_NET_ADMIN) |
                                 (UINT64_C(1) << CAP_NET_RAW) | (UINT64_C(1) << CAP_SYS_PTRACE);
    passed = passed && (uid == 0 ? (result.capabilities & root_capabilities) == root_capabilities
                                 : result.capabilities == 0);
    if (!enforcing())
        fatal("policy_lost_enforcement");
    cases++;
    failures += !passed;
    printf("OKOU_CALLER_CASE "
           "{\"name\":\"%s\",\"uid\":%u,\"capEff\":\"%016" PRIx64
           "\",\"context\":\"%s\",\"allowed\":%s,\"result\":%d,\"errno\":%"
           "d,\"passed\":%s}\n",
           name, result.uid, result.capabilities, result.context, allowed ? "true" : "false",
           result.result, result.error, passed ? "true" : "false");
    fflush(stdout);
}

int main(void) {
    umask(0);
    if (getpid() != 1) {
        fputs("This fixture must be PID 1 in its disposable Guest.\n", stderr);
        return 2;
    }
    signal(SIGALRM, deadline);
    alarm(25);
    signal(SIGPIPE, SIG_IGN);
    if (mount("proc", "/proc", "proc", 0, NULL) || mount("sysfs", "/sys", "sysfs", 0, NULL) ||
        mount("devtmpfs", "/dev", "devtmpfs", 0, NULL))
        fatal("mount_virtual_filesystems");
    mkdir("/sys/kernel/security", 0755);
    if (mount("securityfs", "/sys/kernel/security", "securityfs", 0, NULL))
        fatal("mount_securityfs");
    mkdir("/sys/fs/selinux", 0755);
    if (mount("selinuxfs", "/sys/fs/selinux", "selinuxfs", 0, NULL))
        fatal("mount_selinuxfs");
    struct utsname uts;
    if (uname(&uts))
        fatal("uname");
    char lsm[256] = {0};
    int lsm_fd = open("/sys/kernel/security/lsm", O_RDONLY | O_CLOEXEC);
    if (lsm_fd < 0 || read(lsm_fd, lsm, sizeof(lsm) - 1) <= 0)
        fatal("read_active_lsm");
    close(lsm_fd);
    lsm[strcspn(lsm, "\n")] = 0;
    printf("OKOU_CALLER_KERNEL {\"release\":\"%s\",\"machine\":\"%s\",\"lsm\":\"%s\"}\n",
           uts.release, uts.machine, lsm);
    fflush(stdout);
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    struct ifreq interface = {0};
    strcpy(interface.ifr_name, "lo");
    if (fd < 0 || ioctl(fd, SIOCGIFFLAGS, &interface))
        fatal("read_loopback");
    interface.ifr_flags |= IFF_UP;
    if (ioctl(fd, SIOCSIFFLAGS, &interface))
        fatal("enable_loopback");
    close(fd);
    int policy = open("/policy", O_RDONLY | O_CLOEXEC);
    struct stat info;
    if (policy < 0 || fstat(policy, &info) || info.st_size <= 0 || info.st_size > 1048576)
        fatal("open_policy");
    void *bytes = malloc((size_t)info.st_size);
    if (!bytes)
        fatal("allocate_policy");
    read_all(policy, bytes, (size_t)info.st_size);
    close(policy);
    fd = open("/sys/fs/selinux/load", O_WRONLY | O_CLOEXEC);
    if (fd < 0)
        fatal("open_policy_load");
    if (write(fd, bytes, (size_t)info.st_size) != info.st_size)
        fatal("load_policy");
    close(fd);
    free(bytes);
    text_file("/sys/fs/selinux/enforce", "1");
    if (!enforcing())
        fatal("require_enforcing");
    if (mount("none", "/fixture", "tmpfs", MS_NOSUID | MS_NODEV, "size=1m"))
        fatal("mount_fixture_tmpfs");
    if (mkdir("/fixture/mount", 0777))
        fatal("create_mount_target");
    create_file("/fixture/protected", "protected_file_t");
    create_file("/fixture/key", "gateway_key_t");
    protected_key_fd = open("/fixture/key", O_RDONLY | O_CLOEXEC);
    if (protected_key_fd < 0)
        fatal("retain_protected_key_descriptor");
    create_file("/fixture/data", "workload_data_t");
    pid_t gateway = server(18080, "gateway_t");
    pid_t ordinary = server(18081, NULL);
    test("agent_model_connect", "agent_t", 0, MODEL_CONNECT, true);
    test("gateway_key_read", "gateway_t", 0, KEY_READ, true);
    test("agent_key_read_denied", "agent_t", 0, KEY_READ, false);
    test("agent_code_write_denied", "agent_t", 0, PROTECTED_WRITE, false);
    test("user_model_connect_denied", "workload_t", 1000, MODEL_CONNECT, false);
    test("root_model_connect_denied", "workload_t", 0, MODEL_CONNECT, false);
    test("root_model_bind_denied", "workload_t", 0, MODEL_BIND, false);
    test("user_data_write", "workload_t", 1000, DATA_WRITE, true);
    test("root_data_write", "workload_t", 0, DATA_WRITE, true);
    test("user_ordinary_network", "workload_t", 1000, ORDINARY_CONNECT, true);
    test("root_ordinary_network", "workload_t", 0, ORDINARY_CONNECT, true);
    test("root_code_write_denied", "workload_t", 0, PROTECTED_WRITE, false);
    test("user_code_write_denied", "workload_t", 1000, PROTECTED_WRITE, false);
    test("root_key_read_denied", "workload_t", 0, KEY_READ, false);
    test("root_disable_policy_denied", "workload_t", 0, DISABLE_POLICY, false);
    test("root_relabel_denied", "workload_t", 0, RELABEL, false);
    test("root_raw_socket_denied", "workload_t", 0, RAW_SOCKET, false);
    test("root_mount_denied", "workload_t", 0, MOUNT, false);
    test("root_process_memory_denied", "workload_t", 0, PROCESS_MEMORY, false);
    test("root_forge_role_denied", "workload_t", 0, FORGE_ROLE, false);
    test("root_inherited_socket_denied", "workload_t", 0, INHERITED_SOCKET, false);
    test("root_steal_key_fd_denied", "workload_t", 0, STEAL_KEY_FD, false);
    test("root_inherited_key_denied", "workload_t", 0, INHERITED_KEY, false);
    test("root_network_control_denied", "workload_t", 0, NETWORK_CONTROL, false);
    close(protected_key_fd);
    if (kill(gateway, SIGKILL) || kill(ordinary, SIGKILL))
        fatal("stop_fixture_servers");
    if (waitpid(gateway, NULL, 0) != gateway || waitpid(ordinary, NULL, 0) != ordinary)
        fatal("join_fixture_servers");
    printf("OKOU_CALLER_DONE {\"cases\":%u,\"failures\":%u,\"enforcing\":true}\n", cases, failures);
    fflush(stdout);
    reboot(LINUX_REBOOT_CMD_RESTART);
    for (;;)
        pause();
}

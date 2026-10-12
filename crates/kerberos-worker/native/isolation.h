/* Private Linux bootstrap. No credential bytes may be received before success. */
#ifndef OKOU_KERBEROS_ISOLATION_H
#define OKOU_KERBEROS_ISOLATION_H
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/mount.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error unsupported worker architecture
#endif
#define PERMIT(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
static void erase(void *buffer, size_t size) {
    volatile unsigned char *p = buffer;
    while (size--) *p++ = 0;
}
static int mapping(const char *path, const char *value) {
    int fd = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    size_t size = strlen(value);
    int result = write(fd, value, size) == (ssize_t)size ? 0 : -1;
    if (close(fd)) result = -1;
    return result;
}
static int isolate(void) {
    const char *files[] = {"profile.conf", "input.cache", "input.keytab"};
    int inputs[3] = {-1, -1, -1};
    char root[4096], text[128], target[4352];
    struct stat st;
    pid_t parent = getppid();
    uid_t uid = getuid(); gid_t gid = getgid();
    umask(077);
    if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) || getppid() != parent ||
        !getcwd(root, sizeof(root)) || lstat(root, &st) || !S_ISDIR(st.st_mode) ||
        st.st_uid != uid || (st.st_mode & 0777) != 0700) return -1;
    if (fstat(0, &st) || !S_ISFIFO(st.st_mode) || fstat(1, &st) || !S_ISFIFO(st.st_mode)) return -1;
    if (syscall(SYS_close_range, 2U, ~0U, 0U) || unshare(CLONE_NEWUSER | CLONE_NEWNS)) return -1;
    int n = snprintf(text, sizeof(text), "0 %lu 1\n", (unsigned long)uid);
    if (n <= 0 || (size_t)n >= sizeof(text) || mapping("/proc/self/uid_map", text) ||
        mapping("/proc/self/setgroups", "deny\n")) return -1;
    n = snprintf(text, sizeof(text), "0 %lu 1\n", (unsigned long)gid);
    if (n <= 0 || (size_t)n >= sizeof(text) || mapping("/proc/self/gid_map", text) ||
        mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) return -1;
    /* Open source paths in the NEW mount namespace, before covering the root.
       An O_PATH opened before unshare retains an old-namespace mount and cannot
       be bound here (EINVAL); never broaden policy to work around that mismatch. */
    for (size_t i = 0; i < 3; ++i) {
        n = snprintf(target, sizeof(target), "%s/%s", root, files[i]);
        if (n <= 0 || (size_t)n >= sizeof(target)) return -1;
        inputs[i] = open(target, O_PATH | O_CLOEXEC | O_NOFOLLOW);
        if (inputs[i] < 0 || fstat(inputs[i], &st) || !S_ISREG(st.st_mode) ||
            st.st_uid != getuid() || (st.st_mode & 0777) != 0600 || st.st_nlink != 1 || st.st_size > 4096) return -1;
    }
    if (mount("none", root, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=1048576,nr_inodes=16,mode=0700")) return -1;
    /* Each bind mount retains the exact parent-provisioned inode after unlink.
       The readonly private tmpfs/mounts die with the process, including parent death. */
    for (size_t i = 0; i < 3; ++i) {
        n = snprintf(target, sizeof(target), "%s/%s", root, files[i]);
        if (n <= 0 || (size_t)n >= sizeof(target)) return -1;
        int fd = open(target, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (fd < 0 || close(fd)) return -1;
        n = snprintf(text, sizeof(text), "/proc/self/fd/%d", inputs[i]);
        if (n <= 0 || (size_t)n >= sizeof(text)) return -1;
        if (mount(text, target, NULL, MS_BIND, NULL)) return -1;
        struct mount_attr attributes = {.attr_set = MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC};
        if (syscall(SYS_mount_setattr, AT_FDCWD, target, 0U, &attributes, sizeof(attributes))) return -1;
    }
    struct mount_attr attributes = {.attr_set = MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC};
    if (syscall(SYS_mount_setattr, AT_FDCWD, root, 0U, &attributes, sizeof(attributes)) ||
        chdir("/") || chroot(root) || chdir("/") || syscall(SYS_close_range, 2U, ~0U, 0U)) return -1;
    struct __user_cap_header_struct header = {.version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
    struct __user_cap_data_struct caps[2] = {{0}, {0}};
    if (syscall(SYS_capset, &header, caps) || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) ||
        prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) || getppid() != parent ||
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
    struct rlimit memory = {256UL * 1024 * 1024, 256UL * 1024 * 1024};
    struct rlimit fds = {16, 16}, cpu = {12, 12}, core = {0, 0}, file = {65536, 65536};
    if (setrlimit(RLIMIT_AS, &memory) || setrlimit(RLIMIT_NOFILE, &fds) || setrlimit(RLIMIT_CPU, &cpu) ||
        setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_FSIZE, &file)) return -1;
    int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) return -1;
    struct landlock_ruleset_attr rules = {.handled_access_fs = (1ULL << 15) - 1};
    int policy = (int)syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
    int path = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (policy < 0 || path < 0) return -1;
    struct landlock_path_beneath_attr permit = {
        .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR, .parent_fd = path};
    if (syscall(SYS_landlock_add_rule, policy, LANDLOCK_RULE_PATH_BENEATH, &permit, 0) ||
        syscall(SYS_landlock_restrict_self, policy, 0)) return -1;
    close(path); close(policy);
    /* All native writes are private protocol output, never an opened file.
       Landlock/readonly mounts deny file mutation even through allowed openat. */
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        /* Pinned musl fread uses readv; both APIs read only the same owned pipes
           and readonly fixed inputs. This grants no file mutation or network. */
        PERMIT(read), PERMIT(readv), PERMIT(write), PERMIT(close), PERMIT(openat), PERMIT(fstat),
#ifdef SYS_open
        PERMIT(open),
#endif
#ifdef SYS_stat
        PERMIT(stat),
#endif
#ifdef SYS_lstat
        PERMIT(lstat),
#endif
#ifdef SYS_newfstatat
        PERMIT(newfstatat),
#endif
        PERMIT(getcwd), PERMIT(fcntl), PERMIT(lseek), PERMIT(mmap), PERMIT(mprotect),
        PERMIT(munmap), PERMIT(brk), PERMIT(madvise), PERMIT(getrandom), PERMIT(clock_gettime),
        PERMIT(getpid), PERMIT(getuid), PERMIT(geteuid), PERMIT(getgid), PERMIT(getegid),
        PERMIT(futex), PERMIT(rt_sigaction), PERMIT(rt_sigprocmask), PERMIT(rt_sigreturn),
        PERMIT(exit), PERMIT(exit_group),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
    };
    struct sock_fprog program = {.len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter};
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) return -1;
    for (int family = 0; family < 3; ++family) {
        int families[] = {AF_INET, AF_INET6, AF_UNIX};
        errno = 0;
        if (socket(families[family], SOCK_STREAM, 0) != -1 || errno != EPERM) return -1;
    }
    errno = 0;
    if (syscall(0x7fffffff) != -1 || errno != EPERM) return -1;
#if defined(__x86_64__)
    errno = 0;
    if (syscall(SYS_socket | 0x40000000, AF_INET, SOCK_STREAM, 0) != -1 || errno != EPERM) return -1;
#endif
    if (!lstat("/etc/passwd", &st) || errno != ENOENT) return -1;
    int denied = open("/input.cache", O_WRONLY | O_TRUNC | O_CLOEXEC);
    if (denied >= 0 || (errno != EACCES && errno != EROFS)) return -1;
    unsigned char entropy[16];
    if (getrandom(entropy, sizeof(entropy), 0) != (ssize_t)sizeof(entropy)) return -1;
    erase(entropy, sizeof(entropy));
    return 0;
}
#endif

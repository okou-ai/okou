#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/capability.h>
#include <linux/nsfs.h>
#include <sched.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

static void fail(const char *name) {
  dprintf(2, "PACKAGED_ENTRY %s errno=%d\n", name, errno);
  _exit(125);
}
static void role(const char *name) {
  int fd = open("/proc/self/attr/current", O_WRONLY | O_CLOEXEC);
  char text[128];
  int n = snprintf(text, sizeof(text), "system_u:system_r:%s", name);
  if (fd < 0 || write(fd, text, (size_t)n) != n || close(fd))
    fail("role");
}
static void enter_ns(char target) {
  char cwd[PATH_MAX];
  if (!getcwd(cwd, sizeof(cwd)))
    fail("cwd");
  int peer = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (peer < 0)
    fail("namespace-socket");
  struct timeval timeout = {.tv_sec = 5};
  if (setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)))
    fail("namespace-timeout");
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  const char endpoint[] = "\0okou-native-namespace";
  memcpy(address.sun_path, endpoint, sizeof(endpoint) - 1);
  if (connect(peer, (struct sockaddr *)&address,
              offsetof(struct sockaddr_un, sun_path) + sizeof(endpoint) - 1))
    fail("namespace-connect");
  struct ucred cred;
  socklen_t size = sizeof(cred);
  if (getsockopt(peer, SOL_SOCKET, SO_PEERCRED, &cred, &size) ||
      size != sizeof(cred) || cred.uid != 0)
    fail("namespace-peer-uid");
  char context[128] = {0};
  size = sizeof(context) - 1;
  if (getsockopt(peer, SOL_SOCKET, SO_PEERSEC, context, &size) ||
      strcmp(context, "system_u:system_r:control_t"))
    fail("namespace-peer-context");
  if (send(peer, &target, 1, MSG_NOSIGNAL) != 1)
    fail("namespace-request");
  char marker = 0;
  union {
    struct cmsghdr aligned;
    char bytes[CMSG_SPACE(sizeof(int))];
  } ancillary = {0};
  struct iovec iov = {.iov_base = &marker, .iov_len = 1};
  struct msghdr message = {.msg_iov = &iov,
                           .msg_iovlen = 1,
                           .msg_control = ancillary.bytes,
                           .msg_controllen = sizeof(ancillary.bytes)};
  if (recvmsg(peer, &message, MSG_CMSG_CLOEXEC) != 1 || marker != 'N' ||
      message.msg_flags & (MSG_TRUNC | MSG_CTRUNC))
    fail("namespace-response");
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (!header || header->cmsg_level != SOL_SOCKET ||
      header->cmsg_type != SCM_RIGHTS ||
      header->cmsg_len != CMSG_LEN(sizeof(int)) ||
      CMSG_NXTHDR(&message, header))
    fail("namespace-fd");
  int fd;
  memcpy(&fd, CMSG_DATA(header), sizeof(fd));
  if (close(peer) || ioctl(fd, NS_GET_NSTYPE) != CLONE_NEWNS)
    fail("namespace-type");
  if (setns(fd, CLONE_NEWNS))
    fail("namespace-setns");
  if (close(fd))
    fail("namespace-close");
  /* setns resets fs.root to the namespace root; this initramfs fixture uses
     a chroot below that root rather than production Guest PID 1 boot. */
  if (chdir("/rootfs") || chroot(".") || chdir(cwd))
    fail("namespace-root");
}
static void diagnostic(void) {
  char context[128] = {0}, status[4096] = {0};
  int fd = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC);
  if (fd >= 0) {
    ssize_t n = read(fd, context, sizeof(context) - 1);
    if (n >= 0)
      context[n] = 0;
    close(fd);
  }
  fd = open("/proc/self/status", O_RDONLY | O_CLOEXEC);
  if (fd >= 0) {
    ssize_t n = read(fd, status, sizeof(status) - 1);
    if (n >= 0)
      status[n] = 0;
    close(fd);
  }
  char *cap = strstr(status, "CapEff:"), *nnp = strstr(status, "NoNewPrivs:");
  if (cap) {
    char *end = strchr(cap, '\n');
    if (end)
      *end = 0;
  }
  if (nnp) {
    char *end = strchr(nnp, '\n');
    if (end)
      *end = 0;
  }
  dprintf(2, "PACKAGED_ENTRY uid=%d euid=%d context=%s cap=%s nnp=%s\n",
          getuid(), geteuid(), context, cap ? cap : "unknown",
          nnp ? nnp : "unknown");
}
static void user(void) {
  if (setgroups(0, NULL) || setresgid(1000, 1000, 1000) ||
      setresuid(1000, 1000, 1000))
    fail("uid");
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
  struct __user_cap_data_struct data[2] = {0};
  if (syscall(SYS_capset, &header, data))
    fail("drop-launch-capabilities");
}
static void placement(const char *leaf) {
  char path[256];
  snprintf(path, sizeof(path),
           "/sys/fs/cgroup/vm0-exec/exec-native/workload/%s/cgroup.procs",
           leaf);
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0 || write(fd, "0", 1) != 1 || close(fd))
    fail("initial-placement");
}
static void frozen_env(void) {
  char *session = getenv("OKOU_PI_SESSION_ID"),
       *ipc = getenv("NODE_CHANNEL_FD");
  char session_copy[64] = {0}, ipc_copy[16] = {0};
  if (session && strlen(session) == 36) {
    for (int i = 0; i < 36; i++) {
      if (i == 8 || i == 13 || i == 18 || i == 23) {
        if (session[i] != '-')
          fail("session-id");
      } else if (!((session[i] >= '0' && session[i] <= '9') ||
                   (session[i] >= 'a' && session[i] <= 'f')))
        fail("session-id");
    }
    strcpy(session_copy, session);
  }
  if (ipc && !strcmp(ipc, "4"))
    strcpy(ipc_copy, ipc);
  if (clearenv())
    fail("clearenv");
  FILE *f = fopen("/fixture/environment", "r");
  if (!f)
    fail("environment");
  char *line = NULL;
  size_t size = 0;
  ssize_t n;
  while ((n = getline(&line, &size, f)) > 0) {
    if (line[n - 1] == '\n')
      line[--n] = 0;
    char *equal = strchr(line, '=');
    if (!equal)
      fail("environment-line");
    *equal = 0;
    if (setenv(line, equal + 1, 1))
      fail("setenv");
  }
  free(line);
  fclose(f);
  if (*session_copy)
    setenv("OKOU_PI_SESSION_ID", session_copy, 1);
  if (*ipc_copy)
    setenv("NODE_CHANNEL_FD", ipc_copy, 1);
}
int main(int argc, char **argv) {
  const char *leaf = strrchr(argv[0], '/');
  leaf = leaf ? leaf + 1 : argv[0];
  if (!strcmp(leaf, "guest-tool-exec")) {
    diagnostic();
    if (argc == 2 && !strcmp(argv[1], "hook")) {
      user();
      role("workload_t");
      argv[0] = "/fixture/real-guest-tool-exec";
      execv(argv[0], argv);
      fail("hook-exec");
    }
    enter_ns('T');
    user();
    role("workload_t");
    argv[0] = "/fixture/real-guest-tool-exec";
    execv(argv[0], argv);
    fail("tool-exec");
  }
  if (!strcmp(leaf, "guest-task-exec")) {
    diagnostic();
    if (argc == 3 && !strcmp(argv[1], "stop")) {
      user();
      role("workload_t");
      argv[0] = "/fixture/real-guest-task-exec";
      execv(argv[0], argv);
      fail("stop-exec");
    }
    if (argc != 8 || strcmp(argv[1], "--report-fd") || strcmp(argv[2], "3") ||
        strcmp(argv[3], "--") || strcmp(argv[4], "/usr/bin/node") ||
        strcmp(argv[5], "/usr/local/lib/okou-cli/9.400.3/okou.js") ||
        strcmp(argv[6], "__subagent_loop__"))
      fail("fixed-task-entry");
    const char *prefix = "/tmp/pi/88888888-8888-4888-8888-888888888888/";
    if (strlen(argv[7]) <= strlen(prefix))
      fail("task-directory");
    const char *id = argv[7] + strlen(prefix);
    if (strncmp(argv[7], prefix, strlen(prefix)) || *id < '1' || *id > '9')
      fail("task-directory");
    for (const char *p = id; *p; p++)
      if (*p < '0' || *p > '9')
        fail("task-directory");
    frozen_env();
    setenv("OKOU_PI_SESSION_ROLE", "child", 1);
    enter_ns('A');
    user();
    role("agent_t");
    argv[0] = "/fixture/real-guest-task-exec";
    execv(argv[0], argv);
    fail("task-exec");
  }
  if (argc < 3)
    fail("arguments");
  if (!strcmp(argv[1], "keeper")) {
    if (unshare(CLONE_NEWNS) ||
        mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL))
      fail("agent-ns");
    const char *dirs[] = {"/usr", "/etc", "/opt", NULL};
    for (int i = 0; dirs[i]; i++) {
      char source[128];
      snprintf(source, sizeof(source), "/sealed%s", dirs[i]);
      if (mount(source, dirs[i], NULL, MS_BIND | MS_REC, NULL))
        fail("agent-seal");
    }
    const char *shells[] = {"bash", "dash", NULL};
    for (int i = 0; shells[i]; i++) {
      char source[128], target[128];
      snprintf(source, sizeof(source), "/fixture/workload-shell-%s", shells[i]);
      snprintf(target, sizeof(target), "/usr/bin/%s", shells[i]);
      if (mount(source, target, NULL, MS_BIND, NULL))
        fail("fixed-workload-shell");
    }
    puts("ready");
    fflush(stdout);
    for (;;)
      pause();
  } else if (!strcmp(argv[1], "agent")) {
    placement("runtime");
    enter_ns('A');
    user();
    role("agent_t");
  } else if (!strcmp(argv[1], "workload")) {
    placement("tools");
    enter_ns('T');
    user();
    role("workload_t");
  } else if (!strcmp(argv[1], "root")) {
    placement("tools");
    enter_ns('T');
    role("workload_t");
  } else
    fail("unknown-role");
  execv(argv[2], argv + 2);
  fail("exec");
}

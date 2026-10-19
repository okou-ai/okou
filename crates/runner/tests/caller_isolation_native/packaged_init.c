#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/reboot.h>
#include <net/if.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail(const char *name) {
  dprintf(1, "PACKAGED_FATAL %s errno=%d\n", name, errno);
  reboot(LINUX_REBOOT_CMD_RESTART);
  _exit(1);
}
static void mount_fs(const char *source, const char *target, const char *type,
                     unsigned long flags, const char *data) {
  if (mount(source, target, type, flags, data))
    fail(target);
}
int main(void) {
  mkdir("/dev", 0755);
  mount_fs("devtmpfs", "/dev", "devtmpfs", 0, NULL);
  mkdir("/rootfs", 0755);
  mount_fs("/dev/vda", "/rootfs", "ext4", 0, NULL);
  mkdir("/rootfs/sealed", 0755);
  mount_fs("/dev/vdc", "/rootfs/sealed", "ext4", MS_RDONLY, NULL);
  mkdir("/rootfs/fixture", 0755);
  mount_fs("tmpfs", "/rootfs/fixture", "tmpfs", 0, "mode=0755");
  const char *files[] = {"guest.py",
                         "packaged_resources.py",
                         "packaged_accounting.py",
                         "packaged_audit.py",
                         "packaged_browser.py",
                         "packaged_history.py",
                         "packaged_mcp.py",
                         "packaged_mcp_peer.py",
                         "packaged_storage.py",
                         "packaged_lifecycle.py",
                         "packaged_home.py",
                         "packaged_gateway.py",
                         "packaged_gateway_checks.py",
                         "packaged_vendor_resources.py",
                         "packaged_inprocess.py",
                         "packaged_resolver.py",
                         "packaged_startup.py",
                         "home-manifest.json",
                         "gateway-cert.pem",
                         "gateway-tls-key.pem",
                         "guest-home-mount",
                         "guest-storage-apply",
                         "resource-policy",
                         "policy",
                         "entry",
                         "real-guest-tool-exec",
                         "real-guest-task-exec",
                         NULL};
  for (int i = 0; files[i]; i++) {
    char source[256], target[256], data[16384];
    snprintf(source, sizeof(source), "/fixture/%s", files[i]);
    snprintf(target, sizeof(target), "/rootfs/fixture/%s", files[i]);
    int in = open(source, O_RDONLY),
        out = open(target, O_WRONLY | O_CREAT | O_EXCL, 0755);
    if (in < 0 || out < 0)
      fail("copy-open");
    ssize_t n;
    while ((n = read(in, data, sizeof(data))) > 0) {
      ssize_t done = 0;
      while (done < n) {
        ssize_t wrote = write(out, data + done, (size_t)(n - done));
        if (wrote <= 0)
          fail("copy-write");
        done += wrote;
      }
    }
    if (n < 0 || close(in) || close(out))
      fail("copy-close");
  }
  /* Cover the initramfs root before changing fs.root. A plain chroot makes
     the kernel reject unprivileged user namespaces even for control_t. */
  if (chdir("/rootfs") || mount("/rootfs", "/", NULL, MS_MOVE, NULL) ||
      chroot(".") || chdir("/"))
    fail("switch-root");
  mount_fs("proc", "/proc", "proc", 0, NULL);
  mount_fs("sysfs", "/sys", "sysfs", 0, NULL);
  mount_fs("securityfs", "/sys/kernel/security", "securityfs", 0, NULL);
  mount_fs("devtmpfs", "/dev", "devtmpfs", 0, NULL);
  mkdir("/dev/pts", 0755);
  mount_fs("devpts", "/dev/pts", "devpts", MS_NOSUID | MS_NOEXEC,
           "gid=5,mode=0620,ptmxmode=0666");
  mkdir("/dev/shm", 01777);
  mount_fs("tmpfs", "/dev/shm", "tmpfs", 0, "mode=1777");
  mount_fs("selinuxfs", "/sys/fs/selinux", "selinuxfs", 0, NULL);
  int sock = socket(AF_INET, SOCK_DGRAM, 0);
  struct ifreq lo = {.ifr_name = "lo"};
  if (sock < 0 || ioctl(sock, SIOCGIFFLAGS, &lo))
    fail("loopback-get");
  lo.ifr_flags |= IFF_UP | IFF_RUNNING;
  if (ioctl(sock, SIOCSIFFLAGS, &lo) || close(sock))
    fail("loopback-up");
  int in = open("/fixture/policy", O_RDONLY),
      out = open("/sys/fs/selinux/load", O_WRONLY);
  struct stat st;
  if (in < 0 || out < 0 || fstat(in, &st))
    fail("policy-open");
  char *bytes = malloc((size_t)st.st_size);
  if (!bytes || read(in, bytes, (size_t)st.st_size) != st.st_size ||
      write(out, bytes, (size_t)st.st_size) != st.st_size)
    fail("policy-load");
  close(in);
  close(out);
  free(bytes);
  out = open("/sys/fs/selinux/enforce", O_WRONLY);
  if (out < 0 || write(out, "1", 1) != 1 || close(out))
    fail("enforcing-before-home-mount");
  /* Unlabelled retained data gets a default label without a recursive relabel.
     Protected discovery/state overlays receive explicit controller labels. */
  mount_fs("/dev/vdb", "/home/user", "ext4", 0,
           "defcontext=system_u:object_r:workload_data_t");
  mount_fs("cgroup2", "/sys/fs/cgroup", "cgroup2", 0, NULL);
  pid_t setup = fork();
  if (setup < 0)
    fail("resource-policy-fork");
  if (setup == 0) {
    execl("/fixture/resource-policy", "resource-policy", NULL);
    fail("resource-policy-exec");
  }
  int resource_status;
  if (waitpid(setup, &resource_status, 0) != setup ||
      !WIFEXITED(resource_status) || WEXITSTATUS(resource_status))
    fail("resource-policy-setup");
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL))
    fail("private-root");
  int ready[2];
  if (pipe2(ready, O_CLOEXEC))
    fail("workload-ready-pipe");
  pid_t workload = fork();
  if (workload < 0)
    fail("workload-keeper-fork");
  if (workload == 0) {
    close(ready[0]);
    if (unshare(CLONE_NEWNS) ||
        mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL))
      fail("workload-namespace");
    mount_fs("/sys/fs/cgroup", "/sys/fs/cgroup", NULL, MS_BIND, NULL);
    mount_fs(NULL, "/sys/fs/cgroup", NULL, MS_BIND | MS_REMOUNT | MS_RDONLY,
             NULL);
    if (write(ready[1], "R", 1) != 1 || close(ready[1]))
      fail("workload-ready-write");
    for (;;)
      pause();
  }
  close(ready[1]);
  char observed;
  if (read(ready[0], &observed, 1) != 1 || observed != 'R' || close(ready[0]))
    fail("workload-ready-read");
  char workload_pid[32];
  snprintf(workload_pid, sizeof(workload_pid), "%d", workload);
  if (setenv("OKOU_NATIVE_WORKLOAD_KEEPER_PID", workload_pid, 1))
    fail("workload-pid");
  const char *protected_dirs[] = {"/usr", "/etc", "/opt", NULL};
  for (int i = 0; protected_dirs[i]; i++) {
    char source[128];
    snprintf(source, sizeof(source), "/sealed%s", protected_dirs[i]);
    if (mount(source, protected_dirs[i], NULL, MS_BIND | MS_REC, NULL))
      fail("control-runtime-seal");
  }
  execl("/usr/bin/python3", "python3", "/fixture/guest.py", NULL);
  fail("python-exec");
}

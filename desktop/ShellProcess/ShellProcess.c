#include "ShellProcess.h"
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <util.h>

int okou_shell_spawn(const char *cwd, char *const environment[], int *terminal, int *metadata) {
    int events[2];
    if (pipe(events) != 0) return -1;
    fcntl(events[0], F_SETFD, FD_CLOEXEC);
    fcntl(events[1], F_SETFD, FD_CLOEXEC);
    struct winsize size = {.ws_row = 40, .ws_col = 120};
    pid_t pid = forkpty(terminal, NULL, NULL, &size);
    if (pid == 0) {
        // Only async-signal-safe operations between fork and exec. No Swift,
        // allocation, Foundation, or environment mutation runs in the child.
        close(events[0]);
        if (dup2(events[1], 3) < 0) _exit(126);
        if (events[1] != 3) close(events[1]);
        if (fcntl(3, F_SETFD, 0) < 0 || chdir(cwd) != 0) _exit(126);
        sigset_t empty;
        sigemptyset(&empty);
        sigprocmask(SIG_SETMASK, &empty, NULL);
        char *arguments[] = {"/bin/zsh", "-i", NULL};
        execve(arguments[0], arguments, environment);
        _exit(127);
    }
    close(events[1]);
    if (pid < 0) {
        close(events[0]);
        return -1;
    }
    fcntl(*terminal, F_SETFD, FD_CLOEXEC);
    fcntl(*terminal, F_SETFL, O_NONBLOCK);
    fcntl(events[0], F_SETFL, O_NONBLOCK);
    *metadata = events[0];
    return pid;
}

int okou_shell_exit(pid_t pid, int *code, int *signal_number) {
    int status;
    pid_t result = waitpid(pid, &status, WNOHANG);
    if (result <= 0) return (result < 0 && errno != EINTR) ? -1 : 0;
    *code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    *signal_number = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
    return 1;
}

void okou_shell_stop(pid_t pid, int terminal, int reaped) {
    // Job control puts background jobs in separate process groups. Include all
    // remaining members of this PTY session, not only its current foreground.
    int capacity = proc_listallpids(NULL, 0);
    if (capacity > 0 && pid > 0) {
        capacity += 128;
        pid_t *members = calloc((size_t)capacity, sizeof(pid_t));
        if (members != NULL) {
            int count = proc_listallpids(members, capacity * (int)sizeof(pid_t));
            for (int i = 0; i < count && i < capacity; i++) {
                if (members[i] > 0 && members[i] != pid && getsid(members[i]) == pid)
                    kill(members[i], SIGKILL);
            }
            free(members);
        }
    }
    pid_t foreground = tcgetpgrp(terminal);
    if (foreground > 0 && foreground != getpgrp()) kill(-foreground, SIGKILL);
    if (!reaped && pid > 0) {
        kill(-pid, SIGHUP);
        kill(pid, SIGKILL);
        int status;
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    }
}

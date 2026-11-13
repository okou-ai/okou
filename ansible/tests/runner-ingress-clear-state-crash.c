// Crash after an OS operation clears existing persisted state. A writer that
// preserves its prior reservation until replacement does not trigger this fault.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

static int truncate_then_crash(int fd, off64_t length, const char *symbol) {
    struct stat metadata;
    int clears_state = length == 0 && fstat(fd, &metadata) == 0 && metadata.st_size > 0;
    int (*real_truncate)(int, off64_t) = dlsym(RTLD_NEXT, symbol);
    int result = real_truncate(fd, length);
    if (result == 0 && clears_state) kill(getpid(), SIGKILL);
    return result;
}

int ftruncate(int fd, off_t length) {
    return truncate_then_crash(fd, length, "ftruncate");
}

int ftruncate64(int fd, off64_t length) {
    return truncate_then_crash(fd, length, "ftruncate64");
}

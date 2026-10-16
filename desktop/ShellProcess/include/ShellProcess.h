#pragma once
#include <stddef.h>
#include <sys/types.h>

int okou_shell_spawn(const char *cwd, char *const environment[], int *terminal, int *metadata);
int okou_shell_exit(pid_t pid, int *code, int *signal_number);
void okou_shell_stop(pid_t pid, int terminal, int reaped);

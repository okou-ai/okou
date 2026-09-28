#!/usr/bin/env python3
"""Guard the host ownership split: private Runner socket prerequisites vs. staged Caddy."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PROVISION = ROOT / "ansible/playbooks/provision-runner.yml"
STAGE = ROOT / "ansible/playbooks/stage-runner-wss-ingress.yml"
SOCKET_DIR = "/run/okou-ws"
TMPFILES = "/etc/tmpfiles.d/okou-wss.conf"
TMPFILES_CONTENT = "d /run/okou-ws 0710 root okou-wss-caddy - -\n"


def tasks(path):
    plays = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert len(plays) == 1
    return plays[0]["tasks"]


def only_task(items, module, field, value):
    matches = [
        (index, task)
        for index, task in enumerate(items)
        if isinstance(task.get(module), dict) and task[module].get(field) == value
    ]
    assert len(matches) == 1, (module, field, value, matches)
    return matches[0]


def main():
    provision, stage = tasks(PROVISION), tasks(STAGE)

    dir_stat_index, dir_stat = only_task(provision, "ansible.builtin.stat", "path", SOCKET_DIR)
    tmp_stat_index, tmp_stat = only_task(provision, "ansible.builtin.stat", "path", TMPFILES)
    assert dir_stat["ansible.builtin.stat"]["follow"] is False
    assert tmp_stat["ansible.builtin.stat"]["follow"] is False
    preflight_index, preflight = only_task(
        provision, "ansible.builtin.assert", "fail_msg",
        "Refusing unsafe existing Runner WSS socket directory or tmpfiles configuration.",
    )
    checks = "\n".join(preflight["ansible.builtin.assert"]["that"])
    for expected in (
        "runner_wss_socket_directory.stat.isdir",
        "runner_wss_socket_directory.stat.pw_name == 'root'",
        "runner_wss_socket_directory.stat.gr_name == 'okou-wss-caddy'",
        "runner_wss_socket_directory.stat.mode == '0710'",
        "runner_wss_tmpfiles_config.stat.isreg",
        "runner_wss_tmpfiles_config.stat.pw_name == 'root'",
        "runner_wss_tmpfiles_config.stat.gr_name == 'root'",
        "runner_wss_tmpfiles_config.stat.mode == '0644'",
    ):
        assert expected in checks, expected
    foreign_index, foreign = only_task(
        provision, "ansible.builtin.assert", "fail_msg",
        "Refusing to replace a foreign Runner WSS tmpfiles configuration.",
    )
    assert foreign["when"] == "runner_wss_tmpfiles_config.stat.exists"
    assert "runner_wss_existing_tmpfiles.content | b64decode" in foreign["ansible.builtin.assert"]["that"][0]
    group_index, group = only_task(provision, "ansible.builtin.group", "name", "okou-wss-caddy")
    assert group["ansible.builtin.group"]["system"] is True
    copy_index, config = only_task(provision, "ansible.builtin.copy", "dest", TMPFILES)
    assert config["ansible.builtin.copy"] == {
        "dest": TMPFILES, "content": TMPFILES_CONTENT,
        "owner": "root", "group": "root", "mode": "0644",
    }
    file_index, directory = only_task(provision, "ansible.builtin.file", "path", SOCKET_DIR)
    assert directory["ansible.builtin.file"] == {
        "path": SOCKET_DIR, "state": "directory", "owner": "root",
        "group": "okou-wss-caddy", "mode": "0710",
    }
    assert dir_stat_index < preflight_index < foreign_index < group_index < copy_index < file_index
    assert tmp_stat_index < preflight_index
    assert not any(task.get("when") for task in (group, config, directory))

    # Ingress staging must require, validate, and never silently create/repair
    # the Runner-owned prerequisites. It still cannot start or enable Caddy.
    path_stat_index, path_stat = only_task(stage, "ansible.builtin.stat", "path", "{{ item.path }}")
    assert path_stat["loop"][0] == {
        "path": SOCKET_DIR, "owner": "root", "group": "okou-wss-caddy", "mode": "0710",
    }
    file_stat_index, file_stat = only_task(stage, "ansible.builtin.stat", "path", "{{ item }}")
    assert file_stat["loop"][3] == TMPFILES
    requirement_index, requirement = only_task(
        stage, "ansible.builtin.assert", "fail_msg",
        "Run provision-runner.yml to prepare the protected Runner WSS socket directory before staging ingress.",
    )
    assert requirement["ansible.builtin.assert"]["that"] == [
        "wss_paths.results[0].stat.exists",
        "wss_existing_files.results[3].stat.exists",
    ]
    assert path_stat_index < requirement_index and file_stat_index < requirement_index
    for task in stage:
        assert task.get("ansible.builtin.file", {}).get("path") != SOCKET_DIR
        assert task.get("ansible.builtin.copy", {}).get("dest") != TMPFILES
        assert "ansible.builtin.group" not in task
        systemd = task.get("ansible.builtin.systemd", {})
        assert systemd.get("state") != "started"
        assert systemd.get("enabled") is not True
    print("PASS: Runner WSS socket host preflight/provisioning and ingress stage-only boundary")


if __name__ == "__main__":
    main()

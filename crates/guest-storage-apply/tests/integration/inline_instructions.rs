use guest_storage_apply::apply_agent_instructions;
use std::fs;

#[test]
fn inline_instructions_preserve_bytes_clear_empty_and_keep_unrelated_home_files() {
    for (framework, root, filename, alternate) in [
        ("claude-code", ".claude", "CLAUDE.md", "AGENTS.md"),
        ("codex", ".codex", "AGENTS.md", "CLAUDE.md"),
        ("pi", ".pi/agent", "AGENTS.md", "CLAUDE.md"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("private-source");
        let home = dir.path().join(root);
        for content in ["\u{feff}  指令\n[AGENT_PROFILE]\nkeep raw\n\n", ""] {
            fs::write(&source, content).unwrap();
            assert!(apply_agent_instructions(dir.path(), framework, &source));
            assert_eq!(fs::read(home.join(filename)).unwrap(), content.as_bytes());
            assert!(!home.join(alternate).exists());
            fs::create_dir_all(home.join("skills/keep")).unwrap();
            fs::write(home.join("skills/keep/SKILL.md"), "keep").unwrap();
            fs::write(home.join(alternate), "stale").unwrap();
        }
        assert_eq!(
            fs::read_to_string(home.join("skills/keep/SKILL.md")).unwrap(),
            "keep"
        );
    }
}

#[cfg(unix)]
#[test]
fn inline_instructions_reject_symlinked_pi_parent_and_target() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    fs::write(&source, "new").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join(".pi")).unwrap();
    assert!(!apply_agent_instructions(dir.path(), "pi", &source));
    assert!(!outside.path().join("agent").exists());

    fs::create_dir(dir.path().join(".codex")).unwrap();
    let outside_file = outside.path().join("keep");
    fs::write(&outside_file, "keep").unwrap();
    std::os::unix::fs::symlink(&outside_file, dir.path().join(".codex/AGENTS.md")).unwrap();
    assert!(!apply_agent_instructions(dir.path(), "codex", &source));
    assert_eq!(fs::read_to_string(outside_file).unwrap(), "keep");
}

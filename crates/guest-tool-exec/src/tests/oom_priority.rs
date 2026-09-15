use super::*;
use std::process::Child;
use std::time::Instant;

const CHILD_ENV: &str = "VM0_TEST_TOOL_OOM_PRIORITY_CHILD";

struct TestChild(Child);

impl Drop for TestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn tool_priority_survives_exec_and_descendants_without_changing_parent() {
    if env::var_os(CHILD_ENV).is_some() {
        set_tool_oom_priority().unwrap();
        assert_eq!(
            std::fs::read_to_string("/proc/self/oom_score_adj")
                .unwrap()
                .trim(),
            "1000"
        );
        // Replace the test child with the shell, as the production launcher
        // does. Nested shells exercise ordinary child and grandchild creation.
        let error = Command::new(BASH_PATH)
            .args([
                "-c",
                r#"
set -eu
read -r score < /proc/self/oom_score_adj
test "$score" = 1000
bash -c '
  set -eu
  read -r score < /proc/self/oom_score_adj
  test "$score" = 1000
  bash -c "read -r score < /proc/self/oom_score_adj; test \"\$score\" = 1000"
  test $? = 0
'
test $? = 0
"#,
            ])
            .exec();
        panic!("exec shell: {error}");
    }

    let parent_score = std::fs::read_to_string("/proc/self/oom_score_adj").unwrap();
    let mut child = TestChild(
        Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::oom_priority::tool_priority_survives_exec_and_descendants_without_changing_parent",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "OOM-priority child failed: {status}");
            break;
        }
        assert!(Instant::now() < deadline, "OOM-priority child timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read_to_string("/proc/self/oom_score_adj").unwrap(),
        parent_score
    );
}

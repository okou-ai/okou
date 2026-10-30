use super::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    // Admission is synchronous. Other libtest workers must not affect the bound.
    static ALLOCATED: Cell<Option<usize>> = const { Cell::new(None) };
}

struct AllocationObserver;

fn observe(size: usize) {
    let _ = ALLOCATED.try_with(|allocated| {
        if let Some(total) = allocated.get() {
            allocated.set(Some(total.saturating_add(size)));
        }
    });
}

// Test-only transparent System delegation; the observation itself cannot allocate.
unsafe impl GlobalAlloc for AllocationObserver {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        observe(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        observe(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        observe(size);
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: AllocationObserver = AllocationObserver;

struct Measurement;

impl Measurement {
    fn start() -> Self {
        ALLOCATED.with(|allocated| assert!(allocated.replace(Some(0)).is_none()));
        Self
    }

    fn finish(self) -> Option<usize> {
        ALLOCATED.with(Cell::take)
    }
}

impl Drop for Measurement {
    fn drop(&mut self) {
        ALLOCATED.with(|allocated| allocated.set(None));
    }
}

#[test]
fn retained_history_admission_bounds_json_allocation() {
    let home = tempfile::tempdir().unwrap();
    let claude_dir = home.path().join(".claude");
    let project = claude_dir.join("projects/-home-user-workspace");
    std::fs::create_dir_all(&project).unwrap();
    let id = "allocation-regression";
    // Both an ignored field and inspected content can contain dense JSON trees.
    // Construct/write the small fixture before observing admission allocations.
    let dense = format!("{}{{\"x\":0}}", "{\"x\":0},".repeat(16_384));
    let history = format!(
        "{{\"type\":\"user\",\"sessionId\":\"{id}\",\"message\":{{\"content\":[{dense}]}},\"unused\":[{dense}]}}\n"
    );
    std::fs::write(project.join(format!("{id}.jsonl")), &history).unwrap();

    let measurement = Measurement::start();
    let usable =
        retained_session_is_usable(Framework::ClaudeCode, id, claude_dir.to_str().unwrap(), "");
    let allocated = measurement.finish().unwrap();

    assert!(usable.unwrap());
    eprintln!("{} input bytes; {allocated} allocated bytes", history.len());
    // Includes real file resolution/reading, not just the parser. This generous
    // envelope rejects node-count amplification without pinning exact allocations.
    // Total allocator requests are not peak live heap or process RSS.
    assert!(allocated < 8 * history.len(), "allocated {allocated} bytes");
}

#[test]
fn projected_context_preserves_framework_content_rules() {
    for (framework, line, expected) in [
        (
            Framework::ClaudeCode,
            r#"{"type":"user","message":{"content":"Earlier context"}}"#,
            true,
        ),
        (
            Framework::ClaudeCode,
            r#"{"type":"assistant","message":{"content":" \t\n\u2003"}}"#,
            false,
        ),
        (
            Framework::ClaudeCode,
            r#"{"type":"user","message":{"content":[null]}}"#,
            true,
        ),
        (
            Framework::ClaudeCode,
            r#"{"type":"user","message":{"content":[]}}"#,
            false,
        ),
        (
            Framework::ClaudeCode,
            r#"{"type":"user","message":{"content":{"text":"context"}}}"#,
            false,
        ),
        (
            Framework::ClaudeCode,
            r#"{"summary":"context","type":"summary"}"#,
            true,
        ),
        (
            Framework::ClaudeCode,
            r#"{"type":"user","mess\u0061ge":{"content":"context"}}"#,
            true,
        ),
        (
            Framework::ClaudeCode,
            r#"{"type":"user","message":{"content":"context","content":null}}"#,
            false,
        ),
        (
            Framework::ClaudeCode,
            r#"{"type":"user","message":{"content":"context"},"message":{}}"#,
            false,
        ),
        (
            Framework::ClaudeCode,
            r#"{"type":"summary","summary":"context","summary":false}"#,
            false,
        ),
        (
            Framework::Pi,
            r#"{"type":"message","message":{"role":"toolResult","content":[{}]}}"#,
            true,
        ),
        (
            Framework::Pi,
            r#"{"type":"message","message":{"role":"system","content":"context"}}"#,
            false,
        ),
        (
            Framework::Pi,
            r#"{"type":"branch_summary","summary":"context"}"#,
            true,
        ),
        (
            Framework::Pi,
            r#"{"type":"compaction","summary":[]}"#,
            false,
        ),
        (
            Framework::Codex,
            r#"{"type":"response_item","payload":{"role":"assistant","content":[null]}}"#,
            true,
        ),
        (
            Framework::Codex,
            r#"{"type":"response_item","payload":{"arguments":"{}"}}"#,
            true,
        ),
        (
            Framework::Codex,
            r#"{"type":"response_item","payload":{"output":"tool output"}}"#,
            true,
        ),
        (
            Framework::Codex,
            r#"{"type":"response_item","payload":{"content":"context"}}"#,
            false,
        ),
        (
            Framework::Codex,
            r#"{"type":"compacted","payload":{"replacement_history":[{}]}}"#,
            true,
        ),
        (
            Framework::Codex,
            r#"{"type":"compacted","payload":{"message":"compacted context"}}"#,
            true,
        ),
        (
            Framework::Codex,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"context"}}"#,
            true,
        ),
        (
            Framework::Codex,
            r#"{"type":"event_msg","payload":{"type":"other","message":"context"}}"#,
            false,
        ),
        (
            Framework::Codex,
            r#"{"type":"response_item","payload":{"role":"user","content":"context"},"payload":{"content":"context"}}"#,
            false,
        ),
    ] {
        let record = record::parse(line).unwrap();
        assert_eq!(
            native_context_record(framework, &record),
            expected,
            "{line}"
        );
    }
}

#[test]
fn retained_history_validates_ignored_values_and_later_identities() {
    let home = tempfile::tempdir().unwrap();
    let project = home.path().join("projects/-home-user-workspace");
    std::fs::create_dir_all(&project).unwrap();
    let context = r#"{"sessionId":"retained","type":"user","message":{"content":"context"}}"#;
    let deep = format!("{}0{}", "[".repeat(128), "]".repeat(128));
    for (tail, expected) in [
        (
            r#"{"sessionId":"foreign","sessionId":"retained"}"#.to_owned(),
            true,
        ),
        (
            r#"{"sessionId":"retained","sessionId":"foreign"}"#.to_owned(),
            false,
        ),
        (
            r#"{"sessionId":"foreign","sessionId":null}"#.to_owned(),
            true,
        ),
        (r#"{"unused":{"sessionId":"foreign"}}"#.to_owned(), true),
        (r#"[null,3,true,"ignored"]"#.to_owned(), true),
        (r#"{"unused":[0,]}"#.to_owned(), false),
        (r#"{"unused":"\ud800"}"#.to_owned(), false),
        (r#"{"unused":1e400}"#.to_owned(), false),
        (
            r#"{"type":"user","message":{"content":[{},0,]}}"#.to_owned(),
            false,
        ),
        (r#"{} {}"#.to_owned(), false),
        (format!("{{\"unused\":{deep}}}"), false),
    ] {
        std::fs::write(
            project.join("retained.jsonl"),
            format!("{context}\n{tail}\n"),
        )
        .unwrap();
        assert_eq!(
            retained_session_is_usable(
                Framework::ClaudeCode,
                "retained",
                home.path().to_str().unwrap(),
                ""
            )
            .unwrap(),
            expected,
            "{tail}"
        );
    }
}

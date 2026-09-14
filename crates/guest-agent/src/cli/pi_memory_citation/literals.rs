//! Bounded Markdown recognition for isolated citation delimiter examples only.
//! Larger code bodies still go through the private-envelope scanner unchanged.

use super::{CLOSE, OPEN, SourcedChar};

const MAX_CANDIDATE: usize = 4096;

#[derive(Default, PartialEq)]
enum Mode {
    #[default]
    Text,
    Run,
    Inline,
    Header,
    Fence,
}

#[derive(Default)]
pub(super) struct LiteralEscaper {
    mode: Mode,
    pending: Vec<SourcedChar>,
    eligible: bool,
    marker: char,
    width: usize,
    closing: usize,
    fence_start: bool,
    fence_close: bool,
    fence_tail: bool,
    indent: usize,
    escaped: bool,
    token: String,
    token_ended: bool,
}

impl LiteralEscaper {
    pub(super) fn bypass_plain_chunk(&mut self, chunk: &str) -> bool {
        // Single-byte searches use str's optimized ASCII search rather than a
        // Unicode character predicate on every ordinary byte.
        if self.mode != Mode::Text
            || chunk.contains('`')
            || chunk.contains('~')
            || chunk.contains('\\')
            || chunk.contains('\n')
        {
            return false;
        }
        if !chunk.is_empty() {
            self.indent = if chunk.bytes().all(|byte| byte == b' ') {
                self.indent.saturating_add(chunk.len()).min(4)
            } else {
                4
            };
            self.escaped = false;
        }
        true
    }

    pub(super) fn push(&mut self, item: SourcedChar, emit: &mut impl FnMut(SourcedChar, bool)) {
        self.consume(item, emit);
        self.indent = match item.value {
            '\n' => 0,
            ' ' if self.indent < 4 => self.indent + 1,
            _ => 4,
        };
    }

    fn consume(&mut self, item: SourcedChar, emit: &mut impl FnMut(SourcedChar, bool)) {
        let c = item.value;
        match self.mode {
            Mode::Text => {
                if (c == '`' && !self.escaped) || (c == '~' && self.indent <= 3) {
                    self.mode = Mode::Run;
                    self.marker = c;
                    self.width = 1;
                    self.fence_start = self.indent <= 3;
                    self.eligible = true;
                    self.token.clear();
                    self.token_ended = false;
                    self.closing = 0;
                    self.pending.push(item);
                } else {
                    emit(item, false);
                }
                self.escaped = c == '\\' && !self.escaped;
            }
            Mode::Run => {
                if c == self.marker {
                    self.width = self.width.saturating_add(1);
                    self.retain(item, emit);
                } else {
                    if self.fence_start && self.width >= 3 && !(self.marker == '`' && c == '<') {
                        self.mode = Mode::Header;
                    } else if self.marker == '`' {
                        self.mode = Mode::Inline;
                    } else {
                        self.flush(false, emit);
                        self.mode = Mode::Text;
                    }
                    self.consume(item, emit);
                }
            }
            Mode::Inline => {
                if c != '`' && self.closing == self.width {
                    self.flush(self.complete_token(), emit);
                    self.mode = Mode::Text;
                    self.consume(item, emit);
                    return;
                }
                if c == '`' {
                    self.closing = self.closing.saturating_add(1);
                    if self.closing > self.width || !self.complete_token() {
                        self.invalidate(emit);
                    }
                } else {
                    if self.closing > 0 {
                        self.invalidate(emit);
                    }
                    self.closing = 0;
                    self.consume_token(c, false, emit);
                }
                self.retain(item, emit);
            }
            Mode::Header => {
                if c == '\n' {
                    self.mode = Mode::Fence;
                    self.fence_close = true;
                    self.fence_tail = false;
                    self.closing = 0;
                } else if !c.is_ascii_alphanumeric() && !matches!(c, ' ' | '\t' | '\r' | '_' | '-')
                {
                    // Only simple language labels are supported literal fence headers.
                    self.invalidate(emit);
                }
                self.retain(item, emit);
            }
            Mode::Fence => self.consume_fence(item, emit),
        }
    }

    fn consume_fence(&mut self, item: SourcedChar, emit: &mut impl FnMut(SourcedChar, bool)) {
        let c = item.value;
        if c == '\n' {
            let closes = self.fence_close && self.closing >= self.width;
            if !closes {
                if self.closing > 0 {
                    // A failed closing run is non-whitespace body content.
                    self.invalidate(emit);
                }
                self.consume_token(c, true, emit);
            }
            self.retain(item, emit);
            if closes {
                self.flush(self.complete_token(), emit);
                self.mode = Mode::Text;
            }
            self.fence_close = true;
            self.fence_tail = false;
            self.closing = 0;
            return;
        }
        if self.fence_close {
            if self.closing == 0 && c == ' ' && self.indent < 3 {
                self.consume_token(c, true, emit);
            } else if c == self.marker && !self.fence_tail {
                self.closing = self.closing.saturating_add(1);
            } else if self.closing > 0 && matches!(c, ' ' | '\t' | '\r') {
                self.fence_tail = true;
            } else {
                self.fence_close = false;
                if self.closing > 0 {
                    self.invalidate(emit);
                }
                self.consume_token(c, true, emit);
            }
        } else {
            self.consume_token(c, true, emit);
        }
        self.retain(item, emit);
    }

    fn consume_token(
        &mut self,
        c: char,
        whitespace: bool,
        emit: &mut impl FnMut(SourcedChar, bool),
    ) {
        if !self.eligible {
            return;
        }
        if whitespace && matches!(c, ' ' | '\t' | '\r' | '\n') {
            if !self.token.is_empty() {
                if !self.complete_token() {
                    self.invalidate(emit);
                }
                self.token_ended = true;
            }
            return;
        }
        if self.token_ended {
            self.invalidate(emit);
            return;
        }
        self.token.push(c);
        if !OPEN.starts_with(&self.token) && !CLOSE.starts_with(&self.token) {
            self.invalidate(emit);
        }
    }

    fn complete_token(&self) -> bool {
        self.eligible && (self.token == OPEN || self.token == CLOSE)
    }

    fn retain(&mut self, item: SourcedChar, emit: &mut impl FnMut(SourcedChar, bool)) {
        if self.pending.len() >= MAX_CANDIDATE {
            self.invalidate(emit);
        }
        if self.eligible {
            self.pending.push(item);
        } else {
            emit(item, false);
        }
    }

    fn invalidate(&mut self, emit: &mut impl FnMut(SourcedChar, bool)) {
        self.flush(false, emit);
        self.eligible = false;
    }

    fn flush(&mut self, escape: bool, emit: &mut impl FnMut(SourcedChar, bool)) {
        for item in self.pending.drain(..) {
            emit(item, escape);
        }
    }

    pub(super) fn finish(&mut self, emit: &mut impl FnMut(SourcedChar, bool)) {
        let closed = (self.mode == Mode::Inline && self.closing == self.width)
            || (self.mode == Mode::Fence && self.fence_close && self.closing >= self.width);
        self.flush(closed && self.complete_token(), emit);
    }
}

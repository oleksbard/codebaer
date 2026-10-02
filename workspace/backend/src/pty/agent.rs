//! What a claude session is doing, from the hooks it runs. The host starts claude with a settings
//! file whose hooks run this binary with `--agent-hook`, which sends a short summary of each event
//! to the host's hook socket. The host folds the events, and the keys typed into the session, into
//! the session's `Agent`.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SOCK_ENV: &str = "CODEBAER_HOOK_SOCK";
/// A hook socket path outlives its host when the folder that holds it is wiped, and every host numbers its
/// sessions from 1, so a hook proves which host started its claude.
pub const TOKEN_ENV: &str = "CODEBAER_HOOK_TOKEN";
const SESSION_ENV: &str = "CODEBAER_SESSION";
const MAX_DETAIL: usize = 200;
/// More would be parallel calls the label cannot name anyway.
const MAX_CALLS: usize = 16;
const MAX_LINE: u64 = 64 * 1024;

/// Every event this listens to. Claude Code 2.1.287 accepts the whole list in one settings file.
const EVENTS: [&str; 13] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
];
const TOOL_EVENTS: [&str; 4] = ["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Working,
    Approval,
    Question,
    Compacting,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum End {
    Done,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub id: String,
    pub tool: String,
    /// The argument that says what the call does: a shell command's description (else the command),
    /// a file path, a search pattern, a URL.
    pub detail: String,
    pub since_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Agent {
    pub phase: Phase,
    pub since_ms: u64,
    /// When the current turn started, or the last one when idle.
    pub turn_ms: Option<u64>,
    pub took_ms: Option<u64>,
    pub end: Option<End>,
    /// Tool calls of the main loop in the current turn, or the last one when idle.
    pub actions: u32,
    /// The main loop's open calls, oldest first.
    pub calls: Vec<Call>,
    /// The newest call, kept after it finished, for the label between calls.
    pub last: Option<Call>,
    /// The call that waits for approval, which can be a subagent's.
    pub ask: Option<Call>,
    pub subagents: u32,
    /// Counts the changes, so the app can drop a state that reaches it after a newer one.
    pub rev: u64,
    /// The option the permission prompt has selected, moved by the arrow keys.
    #[serde(skip)]
    pick: u8,
    /// Where "No" is in the open permission prompt: last, after one or two kinds of yes.
    #[serde(skip)]
    no: u8,
    /// A subagent's newest call: its PermissionRequest names no call, and its calls stay out of `calls`.
    #[serde(skip)]
    sub_last: Option<Call>,
}

impl Agent {
    pub fn new(now: u64) -> Agent {
        Agent {
            phase: Phase::Idle,
            since_ms: now,
            turn_ms: None,
            took_ms: None,
            end: None,
            actions: 0,
            calls: Vec::new(),
            last: None,
            ask: None,
            subagents: 0,
            rev: 0,
            pick: 0,
            no: NO,
            sub_last: None,
        }
    }

    fn busy(&self) -> bool {
        self.phase != Phase::Idle
    }

    fn enter(&mut self, phase: Phase, now: u64) {
        self.phase = phase;
        self.since_ms = now;
    }

    fn finish(&mut self, end: End, now: u64) {
        // the Esc read as an interrupt did something else, a menu closed, and the turn went on to its real end
        let late = !self.busy() && self.end == Some(End::Interrupted) && end != End::Interrupted;
        if !self.busy() && !late {
            return;
        }
        // a manual /compact between turns: there is no turn to end
        if self.phase == Phase::Compacting && self.end.is_some() {
            self.enter(Phase::Idle, now);
            return;
        }
        self.enter(Phase::Idle, now);
        self.took_ms = self.turn_ms.map(|t| now.saturating_sub(t));
        self.end = Some(end);
        self.calls.clear();
        self.ask = None;
        if end == End::Interrupted {
            // an interrupt reports no SubagentStop
            self.subagents = 0;
        }
    }

    /// The approval ends: answered, or its call finished. Other calls coming and going leave it open.
    fn answered(&mut self, now: u64) {
        self.ask = None;
        self.pick = 0;
        self.enter(Phase::Working, now);
    }

    /// A tool event after the turn looked over: an Esc that only closed a view, or a turn that
    /// started before the host was watching.
    fn resume(&mut self, now: u64) {
        if self.busy() {
            return;
        }
        if self.end != Some(End::Interrupted) {
            self.turn_ms = Some(now);
            self.actions = 0;
            self.last = None;
        }
        self.took_ms = None;
        self.end = None;
        self.enter(Phase::Working, now);
    }
}

/// One hook event, as `--agent-hook` sends it to the host.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Hook {
    pub session: u32,
    pub event: String,
    #[serde(default)]
    pub tool: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub call: String,
    #[serde(default)]
    pub kind: String,
    /// How many options a permission prompt offers, or 0 when the payload does not say.
    #[serde(default)]
    pub options: u8,
    /// The event came from a subagent.
    #[serde(default)]
    pub sub: bool,
    #[serde(default)]
    pub token: String,
}

/// Folds one hook event into the session's agent. Returns whether it changed.
pub fn reduce(a: &mut Agent, h: &Hook, now: u64) -> bool {
    let before = a.clone();
    let call = || Call { id: h.call.clone(), tool: h.tool.clone(), detail: h.detail.clone(), since_ms: now };
    let asked = |a: &Agent| a.ask.as_ref().is_some_and(|c| if c.id.is_empty() { c.tool == h.tool } else { c.id == h.call });
    match h.event.as_str() {
        "UserPromptSubmit" => {
            *a = Agent { turn_ms: Some(now), subagents: a.subagents, rev: a.rev, ..Agent::new(now) };
            a.phase = Phase::Working;
        }
        "PreToolUse" if h.sub => a.sub_last = Some(call()),
        "PreToolUse" => {
            a.resume(now);
            if a.calls.len() < MAX_CALLS {
                a.calls.push(call());
            }
            a.last = Some(call());
            a.actions += 1;
            if a.ask.is_none() {
                a.enter(if h.tool == "AskUserQuestion" { Phase::Question } else { Phase::Working }, now);
            }
        }
        "PostToolUse" | "PostToolUseFailure" => {
            if !h.sub {
                // a call that ends after an Esc ran on through it
                if a.end == Some(End::Interrupted) {
                    a.resume(now);
                }
                let at = a.calls.iter().position(|c| !h.call.is_empty() && c.id == h.call)
                    .or_else(|| a.calls.iter().position(|c| c.tool == h.tool));
                if let Some(i) = at {
                    a.calls.remove(i);
                }
            }
            if asked(a) {
                a.answered(now);
            } else if !h.sub && a.busy() && a.ask.is_none() {
                a.enter(Phase::Working, now);
            }
        }
        "PermissionRequest" => {
            a.resume(now);
            let open = if h.sub { a.sub_last.as_ref() } else { a.calls.iter().rev().find(|c| c.tool == h.tool) };
            a.ask = Some(open.filter(|c| c.tool == h.tool).cloned().unwrap_or_else(call));
            a.pick = 0;
            // the plan's prompt lists its own choices, whatever rules it offers
            a.no = if h.options == 2 && h.tool != "ExitPlanMode" { 1 } else { NO };
            a.enter(Phase::Approval, now);
        }
        "Notification" => match h.kind.as_str() {
            "permission_prompt" if a.phase == Phase::Working => {
                a.pick = 0;
                a.no = NO;
                a.enter(Phase::Approval, now);
            }
            "elicitation_dialog" | "elicitation_url_dialog" if a.busy() => a.enter(Phase::Question, now),
            // Claude says it waits for a prompt: the end of a turn that no Stop reported
            "idle_prompt" if a.busy() && !matches!(a.phase, Phase::Approval | Phase::Question) => {
                a.finish(End::Done, now);
            }
            _ => {}
        },
        "Stop" => a.finish(End::Done, now),
        "StopFailure" => a.finish(End::Failed, now),
        "SubagentStart" => a.subagents += 1,
        "SubagentStop" => a.subagents = a.subagents.saturating_sub(1),
        "PreCompact" => a.enter(Phase::Compacting, now),
        "PostCompact" if a.phase == Phase::Compacting => {
            let next = if a.turn_ms.is_some() && a.end.is_none() { Phase::Working } else { Phase::Idle };
            a.enter(next, now);
        }
        _ => {}
    }
    bump(a, &before)
}

fn bump(a: &mut Agent, before: &Agent) -> bool {
    let changed = *a != *before;
    if changed {
        a.rev = before.rev + 1;
    }
    changed
}

/// Where "No" is when the payload does not say. The permission prompt's options, top to bottom: yes, yes and
/// don't ask again, no. Without a rule to offer, the second goes. "No" stops the turn the way Esc does, and
/// reports no hook either.
const NO: u8 = 2;

/// Folds keys typed into the session. Claude reports no hook for an interrupt, or for an answer to a permission
/// prompt until the tool finishes, so the host reads both from the input. Each key arrives as its own write.
pub fn typed(a: &mut Agent, bytes: &[u8], now: u64) -> bool {
    let before = a.clone();
    // a lone ESC is the Esc key: arrows and the other keys that start with one send a sequence
    if bytes == b"\x1b" || bytes == b"\x03" {
        a.finish(End::Interrupted, now);
    } else if a.phase == Phase::Approval {
        match bytes {
            // `pick` stays off the wire, so moving it is no change to send
            b"\x1b[A" | b"\x1bOA" => {
                a.pick = a.pick.saturating_sub(1);
                return false;
            }
            b"\x1b[B" | b"\x1bOB" => {
                a.pick = (a.pick + 1).min(a.no);
                return false;
            }
            &[d @ b'1'..=b'3'] if d - b'1' == a.no => a.finish(End::Interrupted, now),
            &[d @ b'1'..=b'3'] if d - b'1' < a.no => a.answered(now),
            b"y" | b"Y" => a.answered(now),
            b"n" | b"N" => a.finish(End::Interrupted, now),
            b"\r" if a.pick >= a.no => a.finish(End::Interrupted, now),
            b"\r" => a.answered(now),
            _ => {}
        }
    }
    bump(a, &before)
}

fn clip(s: &str) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(MAX_DETAIL) {
        Some((i, _)) => format!("{}…", &flat[..i]),
        None => flat,
    }
}

fn detail_of(tool: &str, input: &Value) -> String {
    let arg = |k: &str| input.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty());
    let keys: &[&str] = match tool {
        "Bash" | "PowerShell" => &["description", "command"],
        _ => &["file_path", "notebook_path", "pattern", "url", "query", "description", "skill", "path"],
    };
    keys.iter().find_map(|k| arg(k)).map(clip).unwrap_or_default()
}

/// Reads a hook's stdin payload into what the host needs. The payload carries the whole tool
/// input, a file's full text for Write, so only the few fields the label uses leave this process.
pub fn parse(payload: &[u8], session: u32, token: &str) -> Option<Hook> {
    let v: Value = serde_json::from_slice(payload).ok()?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let tool = s("tool_name");
    Some(Hook {
        session,
        event: s("hook_event_name"),
        detail: v.get("tool_input").map(|i| detail_of(&tool, i)).unwrap_or_default(),
        tool,
        call: s("tool_use_id"),
        kind: s("notification_type"),
        // the "don't ask again" option offers these rules, and the prompt leaves it out when there are none
        options: match v.get("permission_suggestions").and_then(Value::as_array) {
            Some(rules) if rules.is_empty() => 2,
            Some(_) => 3,
            None => 0,
        },
        sub: v.get("agent_id").and_then(Value::as_str).is_some_and(|id| !id.is_empty()),
        token: token.to_string(),
    })
}

/// The settings file claude starts with: every event runs `exe --agent-hook`.
pub fn settings(exe: &str) -> String {
    let command = format!("{} --agent-hook", super::daemon::quote(exe));
    let hooks: serde_json::Map<String, Value> = EVENTS
        .iter()
        .map(|e| {
            // short: claude waits for each hook, and this one must never hold a turn up
            let mut group = json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] });
            if TOOL_EVENTS.contains(e) {
                group["matcher"] = json!("*");
            }
            ((*e).to_string(), json!([group]))
        })
        .collect();
    json!({ "hooks": hooks }).to_string()
}

/// `--agent-hook`. Prints nothing and always exits 0: claude adds a hook's output to the model's
/// context for some events and shows an error for a failed one, and this hook only reports.
pub fn hook() -> ! {
    let mut payload = Vec::new();
    // read to the end even past what is used, so claude's write into the pipe never fails
    let _ = std::io::stdin().read_to_end(&mut payload);
    let session = std::env::var(SESSION_ENV).ok().and_then(|s| s.parse().ok());
    let token = std::env::var(TOKEN_ENV).unwrap_or_default();
    if let (Ok(sock), Some(session)) = (std::env::var(SOCK_ENV), session) {
        if let (Some(h), Ok(mut s)) = (parse(&payload, session, &token), UnixStream::connect(sock)) {
            let _ = s.set_write_timeout(Some(Duration::from_secs(1)));
            if let Ok(line) = serde_json::to_vec(&h) {
                let _ = s.write_all(&line);
            }
        }
    }
    std::process::exit(0)
}

/// One hook's line, read from a connection to the hook socket.
pub fn read(stream: &mut UnixStream) -> Option<Hook> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let mut buf = Vec::new();
    stream.take(MAX_LINE).read_to_end(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event: &str) -> Hook {
        Hook { session: 1, event: event.into(), ..Hook::default() }
    }

    fn tool(event: &str, tool: &str, id: &str) -> Hook {
        Hook { tool: tool.into(), call: id.into(), detail: format!("{tool} detail"), ..ev(event) }
    }

    fn turn() -> Agent {
        let mut a = Agent::new(0);
        reduce(&mut a, &ev("UserPromptSubmit"), 1000);
        a
    }

    #[test]
    fn a_turn_runs_from_the_prompt_to_stop_and_counts_its_calls() {
        let mut a = turn();
        assert_eq!((a.phase, a.turn_ms, a.actions), (Phase::Working, Some(1000), 0));
        reduce(&mut a, &tool("PreToolUse", "Read", "t1"), 2000);
        assert_eq!(a.calls.len(), 1);
        reduce(&mut a, &tool("PostToolUse", "Read", "t1"), 2500);
        assert!(a.calls.is_empty());
        assert_eq!(a.last.as_ref().map(|c| c.tool.as_str()), Some("Read"));
        reduce(&mut a, &ev("Stop"), 4000);
        assert_eq!((a.phase, a.end, a.took_ms, a.actions), (Phase::Idle, Some(End::Done), Some(3000), 1));
    }

    #[test]
    fn parallel_calls_close_by_their_own_id() {
        let mut a = turn();
        reduce(&mut a, &tool("PreToolUse", "Grep", "a"), 1);
        reduce(&mut a, &tool("PreToolUse", "Grep", "b"), 2);
        reduce(&mut a, &tool("PostToolUse", "Grep", "b"), 3);
        assert_eq!(a.calls.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["a"]);
    }

    #[test]
    fn an_approval_waits_until_a_key_answers_it() {
        let mut a = turn();
        reduce(&mut a, &tool("PreToolUse", "Bash", "t"), 1);
        reduce(&mut a, &tool("PermissionRequest", "Bash", ""), 2);
        assert_eq!((a.phase, a.ask.as_ref().map(|c| c.id.as_str())), (Phase::Approval, Some("t")));
        assert!(!typed(&mut a, b"x", 3), "a key the prompt does not take changes nothing");
        assert!(typed(&mut a, b"\r", 4));
        assert_eq!((a.phase, a.ask.is_none()), (Phase::Working, true));
    }

    #[test]
    fn no_at_the_permission_prompt_stops_the_turn_like_esc() {
        for keys in [&[b"3".as_slice()][..], &[b"n"], &[b"\x1b[B", b"\x1b[B", b"\r"], &[b"\x1b[B", b"\x1b[B", b"\x1b[B", b"\r"]] {
            let mut a = turn();
            reduce(&mut a, &tool("PreToolUse", "Bash", "t"), 1);
            reduce(&mut a, &tool("PermissionRequest", "Bash", ""), 2);
            for k in keys {
                typed(&mut a, k, 3);
            }
            assert_eq!((a.phase, a.end), (Phase::Idle, Some(End::Interrupted)), "{keys:?}");
        }
        let mut a = turn();
        reduce(&mut a, &tool("PreToolUse", "Bash", "t"), 1);
        reduce(&mut a, &tool("PermissionRequest", "Bash", ""), 2);
        for k in [b"\x1b[B".as_slice(), b"\x1b[A", b"\r"] {
            typed(&mut a, k, 3);
        }
        assert_eq!(a.phase, Phase::Working, "down and up again is yes");
    }

    #[test]
    fn a_prompt_with_no_rule_to_offer_has_no_as_its_second_option() {
        let two = Hook { options: 2, ..tool("PermissionRequest", "Bash", "") };
        for keys in [&[b"2".as_slice()][..], &[b"\x1b[B", b"\r"], &[b"\x1b[B", b"\x1b[B", b"\r"]] {
            let mut a = turn();
            reduce(&mut a, &tool("PreToolUse", "Bash", "t"), 1);
            reduce(&mut a, &two, 2);
            for k in keys {
                typed(&mut a, k, 3);
            }
            assert_eq!((a.phase, a.end), (Phase::Idle, Some(End::Interrupted)), "{keys:?}");
        }
        let mut a = turn();
        reduce(&mut a, &two, 2);
        assert!(!typed(&mut a, b"3", 3), "a third option that is not there");
        assert!(!typed(&mut a, b"\x1b[B", 3), "the selection is not sent");
        assert_eq!(a.phase, Phase::Approval);
        let mut a = turn();
        reduce(&mut a, &Hook { options: 2, ..tool("PermissionRequest", "ExitPlanMode", "") }, 2);
        typed(&mut a, b"2", 3);
        assert_eq!(a.phase, Phase::Working, "the plan's prompt keeps its own layout");
    }

    #[test]
    fn other_calls_coming_and_going_leave_an_approval_open() {
        let mut a = turn();
        reduce(&mut a, &tool("PreToolUse", "Read", "r"), 1);
        reduce(&mut a, &tool("PreToolUse", "WebFetch", "w"), 2);
        reduce(&mut a, &tool("PermissionRequest", "WebFetch", ""), 3);
        reduce(&mut a, &tool("PostToolUse", "Read", "r"), 4);
        reduce(&mut a, &tool("PreToolUse", "Grep", "g"), 5);
        assert_eq!(a.phase, Phase::Approval);
        reduce(&mut a, &tool("PostToolUse", "WebFetch", "w"), 6);
        assert_eq!((a.phase, a.ask.is_none()), (Phase::Working, true));
    }

    #[test]
    fn a_subagents_approval_ends_with_its_own_call() {
        let mut a = turn();
        let sub = |h: Hook| Hook { sub: true, ..h };
        reduce(&mut a, &tool("PreToolUse", "Agent", "main"), 1);
        reduce(&mut a, &sub(tool("PreToolUse", "Bash", "s1")), 2);
        reduce(&mut a, &sub(tool("PermissionRequest", "Bash", "")), 3);
        assert_eq!(a.ask.as_ref().map(|c| c.id.as_str()), Some("s1"));
        reduce(&mut a, &sub(tool("PostToolUse", "Read", "s0")), 4);
        assert_eq!(a.phase, Phase::Approval);
        reduce(&mut a, &sub(tool("PostToolUse", "Bash", "s1")), 5);
        assert_eq!(a.phase, Phase::Working);
    }

    #[test]
    fn stop_after_an_esc_that_stopped_nothing_ends_the_turn_as_done() {
        let mut a = turn();
        typed(&mut a, b"\x1b", 2000);
        assert_eq!(a.end, Some(End::Interrupted));
        let note = Hook { kind: "idle_prompt".into(), ..ev("Notification") };
        assert!(!reduce(&mut a, &note, 2500), "idle_prompt also follows a real interrupt");
        reduce(&mut a, &ev("Stop"), 5000);
        assert_eq!((a.end, a.took_ms), (Some(End::Done), Some(4000)));
    }

    #[test]
    fn every_change_counts_up_the_rev() {
        let mut a = Agent::new(0);
        reduce(&mut a, &ev("UserPromptSubmit"), 1);
        let rev = a.rev;
        assert!(!reduce(&mut a, &ev("SessionEnd"), 2));
        assert_eq!(a.rev, rev);
        typed(&mut a, b"\x1b", 3);
        assert_eq!(a.rev, rev + 1);
    }

    #[test]
    fn esc_or_ctrl_c_interrupts_a_turn_and_nothing_else() {
        for key in [b"\x1b".as_slice(), b"\x03"] {
            let mut a = turn();
            reduce(&mut a, &tool("PreToolUse", "Bash", "t"), 1);
            assert!(typed(&mut a, key, 5000));
            assert_eq!((a.phase, a.end, a.took_ms), (Phase::Idle, Some(End::Interrupted), Some(4000)));
            assert!(a.calls.is_empty());
            assert!(!typed(&mut a, key, 6000), "an idle prompt has no turn to stop");
        }
        let mut a = turn();
        assert!(!typed(&mut a, b"\x1bOA", 2), "a key sequence that starts with ESC is not the Esc key");
    }

    #[test]
    fn a_tool_call_after_an_esc_that_stopped_nothing_resumes_the_same_turn() {
        let mut a = turn();
        reduce(&mut a, &tool("PreToolUse", "Read", "t1"), 2000);
        typed(&mut a, b"\x1b", 3000);
        reduce(&mut a, &tool("PreToolUse", "Edit", "t2"), 4000);
        assert_eq!((a.phase, a.turn_ms, a.actions, a.end), (Phase::Working, Some(1000), 2, None));
    }

    #[test]
    fn subagent_calls_stay_out_of_the_main_loop_but_their_approvals_do_not() {
        let mut a = turn();
        let sub = |h: Hook| Hook { sub: true, ..h };
        reduce(&mut a, &sub(tool("PreToolUse", "Read", "s")), 1);
        assert_eq!((a.actions, a.calls.len()), (0, 0));
        reduce(&mut a, &sub(tool("PermissionRequest", "Bash", "")), 2);
        assert_eq!(a.phase, Phase::Approval);
    }

    #[test]
    fn idle_prompt_ends_a_turn_no_stop_reported() {
        let mut a = turn();
        let note = |kind: &str| Hook { kind: kind.into(), ..ev("Notification") };
        reduce(&mut a, &note("idle_prompt"), 9000);
        assert_eq!((a.phase, a.end), (Phase::Idle, Some(End::Done)));
        let mut b = turn();
        reduce(&mut b, &tool("PermissionRequest", "Bash", ""), 1);
        reduce(&mut b, &note("idle_prompt"), 2);
        assert_eq!(b.phase, Phase::Approval, "the prompt is still open");
    }

    #[test]
    fn an_api_error_and_a_compaction_have_their_own_phase() {
        let mut a = turn();
        reduce(&mut a, &ev("PreCompact"), 1);
        assert_eq!(a.phase, Phase::Compacting);
        reduce(&mut a, &ev("PostCompact"), 2);
        assert_eq!(a.phase, Phase::Working);
        reduce(&mut a, &ev("StopFailure"), 3);
        assert_eq!(a.end, Some(End::Failed));
    }

    #[test]
    fn a_payload_keeps_only_what_the_label_needs() {
        let p = br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"toolu_1",
            "tool_input":{"command":"echo hi","description":"Print\na greeting"}}"#;
        let h = parse(p, 7, "t").unwrap();
        assert_eq!((h.session, h.event.as_str(), h.tool.as_str()), (7, "PreToolUse", "Bash"));
        assert_eq!((h.detail.as_str(), h.call.as_str(), h.sub), ("Print a greeting", "toolu_1", false));
        let w = br#"{"hook_event_name":"PreToolUse","tool_name":"Write","agent_id":"a1",
            "tool_input":{"file_path":"/r/src/a.ts","content":"x"}}"#;
        let h = parse(w, 7, "t").unwrap();
        assert_eq!((h.detail.as_str(), h.sub), ("/r/src/a.ts", true));
        let ask = |rules: &str| {
            let p = format!(r#"{{"hook_event_name":"PermissionRequest","tool_name":"Bash"{rules}}}"#);
            parse(p.as_bytes(), 7, "t").unwrap().options
        };
        assert_eq!(ask(""), 0);
        assert_eq!(ask(r#","permission_suggestions":[]"#), 2);
        assert_eq!(ask(r#","permission_suggestions":[{"type":"addRules"}]"#), 3);
        let n = br#"{"hook_event_name":"Notification","notification_type":"idle_prompt"}"#;
        assert_eq!(parse(n, 7, "t").unwrap().kind, "idle_prompt");
        assert!(parse(b"not json", 7, "t").is_none());
    }

    #[test]
    fn a_long_detail_is_cut_on_a_char_boundary() {
        let long = "ä".repeat(MAX_DETAIL + 10);
        let d = clip(&long);
        assert_eq!(d.chars().count(), MAX_DETAIL + 1);
        assert!(d.ends_with('…'));
    }

    #[test]
    fn the_settings_hook_every_event_and_match_every_tool() {
        let v: Value = serde_json::from_str(&settings("/Applications/CodeBär.app/x")).unwrap();
        let hooks = v["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), EVENTS.len());
        assert_eq!(hooks["PreToolUse"][0]["matcher"], "*");
        assert!(hooks["Stop"][0].get("matcher").is_none());
        assert_eq!(hooks["Stop"][0]["hooks"][0]["command"], "'/Applications/CodeBär.app/x' --agent-hook");
    }
}

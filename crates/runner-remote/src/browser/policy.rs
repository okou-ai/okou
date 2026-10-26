//! Positive CDP surface and protocol-owned resource indexes.

use super::{Failure, Result};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct Page {
    pub target: String,
    pub frames: HashSet<String>,
    pub loaders: HashMap<String, String>,
    pub contexts: HashSet<i64>,
    pub unique_contexts: HashSet<String>,
    pub objects: HashSet<String>,
    pub nodes: HashSet<i64>,
    pub backend_nodes: HashSet<i64>,
}

pub(super) fn allowed(method: &str, params: &Value, session: bool) -> Result<()> {
    let keys: &[&str] = match (session, method) {
        (false, "Browser.getVersion" | "Target.getTargets") => &[],
        (false, "Target.setDiscoverTargets") => &["discover"],
        (false, "Target.attachToTarget") => &["targetId", "flatten"],
        (
            false,
            "Target.activateTarget"
            | "Target.closeTarget"
            | "Target.getTargetInfo"
            | "Browser.getWindowForTarget",
        ) => &["targetId"],
        (false, "Target.detachFromTarget") => &["sessionId"],
        (true, "Target.setAutoAttach") => &["autoAttach", "waitForDebuggerOnStart", "flatten"],
        (
            true,
            "Page.enable"
            | "Page.disable"
            | "Page.getFrameTree"
            | "Page.getLayoutMetrics"
            | "Page.bringToFront"
            | "Runtime.enable"
            | "Runtime.disable"
            | "Runtime.runIfWaitingForDebugger"
            | "DOM.enable"
            | "DOM.disable"
            | "Accessibility.enable"
            | "Accessibility.disable",
        ) => &[],
        (true, "Network.enable") => &[
            "maxTotalBufferSize",
            "maxResourceBufferSize",
            "maxPostDataSize",
        ],
        (true, "Network.disable") => &[],
        (true, "Page.navigate") => &[
            "url",
            "referrer",
            "transitionType",
            "frameId",
            "referrerPolicy",
        ],
        (true, "Page.reload") => &["ignoreCache"],
        (true, "Page.captureScreenshot") => &[
            "format",
            "quality",
            "clip",
            "fromSurface",
            "captureBeyondViewport",
            "optimizeForSpeed",
        ],
        (true, "Page.handleJavaScriptDialog") => &["accept", "promptText"],
        (true, "Runtime.evaluate") => &[
            "expression",
            "includeCommandLineAPI",
            "silent",
            "contextId",
            "returnByValue",
            "generatePreview",
            "userGesture",
            "awaitPromise",
            "throwOnSideEffect",
            "timeout",
            "disableBreaks",
            "replMode",
            "uniqueContextId",
        ],
        (true, "Runtime.callFunctionOn") => &[
            "functionDeclaration",
            "objectId",
            "arguments",
            "silent",
            "returnByValue",
            "generatePreview",
            "userGesture",
            "awaitPromise",
            "executionContextId",
            "throwOnSideEffect",
            "uniqueContextId",
        ],
        (true, "Runtime.getProperties") => &[
            "objectId",
            "ownProperties",
            "accessorPropertiesOnly",
            "generatePreview",
            "nonIndexedPropertiesOnly",
        ],
        (true, "Runtime.releaseObject") => &["objectId"],
        (true, "Accessibility.getFullAXTree") => &["depth", "frameId"],
        (true, "Accessibility.getPartialAXTree") => {
            &["nodeId", "backendNodeId", "objectId", "fetchRelatives"]
        }
        (true, "DOM.getDocument") => &["depth", "pierce"],
        (true, "DOM.describeNode" | "DOM.resolveNode") => &[
            "nodeId",
            "backendNodeId",
            "objectId",
            "depth",
            "pierce",
            "executionContextId",
        ],
        (true, "DOM.querySelector") => &["nodeId", "selector"],
        (true, "DOM.querySelectorAll") => &["nodeId", "selector"],
        (true, "DOM.getBoxModel" | "DOM.getContentQuads" | "DOM.focus") => {
            &["nodeId", "backendNodeId", "objectId"]
        }
        (true, "Input.insertText") => &["text"],
        (true, "Input.dispatchKeyEvent") => &[
            "type",
            "modifiers",
            "timestamp",
            "text",
            "unmodifiedText",
            "code",
            "key",
            "windowsVirtualKeyCode",
            "nativeVirtualKeyCode",
            "autoRepeat",
            "isKeypad",
            "location",
        ],
        (true, "Input.dispatchMouseEvent") => &[
            "type",
            "x",
            "y",
            "modifiers",
            "timestamp",
            "button",
            "buttons",
            "clickCount",
            "force",
            "tangentialPressure",
            "tiltX",
            "tiltY",
            "twist",
            "deltaX",
            "deltaY",
            "pointerType",
        ],
        _ => return Err(Failure),
    };
    let params = params.as_object().ok_or(Failure)?;
    if params.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(Failure);
    }
    if method == "Input.dispatchKeyEvent" {
        let modifiers = params
            .get("modifiers")
            .map_or(Some(0), Value::as_u64)
            .ok_or(Failure)?;
        // Browser accelerators are outside the selected renderer's authority.
        let virtual_key = params
            .get("windowsVirtualKeyCode")
            .map(|value| value.as_u64().ok_or(Failure))
            .transpose()?;
        if params
            .get("nativeVirtualKeyCode")
            .is_some_and(|value| value.as_u64().is_none() || value.as_u64() != virtual_key)
        {
            return Err(Failure);
        }
        if modifiers > 15
            || modifiers & 1 != 0
            || modifiers & 6 == 6
            || virtual_key
                .is_some_and(|key| (112..=135).contains(&key) || (166..=183).contains(&key))
            || ["key", "code"].into_iter().any(|key| {
                params.get(key).and_then(Value::as_str).is_some_and(|key| {
                    key.starts_with("Browser")
                        || key
                            .strip_prefix('F')
                            .and_then(|key| key.parse::<u8>().ok())
                            .is_some_and(|key| (1..=24).contains(&key))
                })
            })
        {
            return Err(Failure);
        }
        if modifiers & 6 != 0 {
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .ok_or(Failure)?
                .to_ascii_lowercase();
            let (code, expected_key) = match key.as_str() {
                "a" => ("KeyA", 65),
                "c" => ("KeyC", 67),
                "v" => ("KeyV", 86),
                "x" => ("KeyX", 88),
                "z" => ("KeyZ", 90),
                "y" => ("KeyY", 89),
                "arrowleft" => ("ArrowLeft", 37),
                "arrowright" => ("ArrowRight", 39),
                "arrowup" => ("ArrowUp", 38),
                "arrowdown" => ("ArrowDown", 40),
                "backspace" => ("Backspace", 8),
                "delete" => ("Delete", 46),
                "control" => ("ControlLeft", 17),
                "meta" => ("MetaLeft", 91),
                "shift" => ("ShiftLeft", 16),
                _ => return Err(Failure),
            };
            if virtual_key
                .is_some_and(|actual| actual != expected_key && !(key == "meta" && actual == 92))
                || params.get("code").is_some_and(|value| {
                    value.as_str() != Some(code)
                        && !matches!(
                            (key.as_str(), value.as_str()),
                            ("control", Some("ControlRight"))
                                | ("meta", Some("MetaRight"))
                                | ("shift", Some("ShiftRight"))
                        )
                })
                || modifiers & 8 != 0
                    && !matches!(
                        key.as_str(),
                        "v" | "z"
                            | "arrowleft"
                            | "arrowright"
                            | "arrowup"
                            | "arrowdown"
                            | "control"
                            | "meta"
                            | "shift"
                    )
            {
                return Err(Failure);
            }
        }
    }
    if method == "Target.attachToTarget" && params.get("flatten") != Some(&Value::Bool(true)) {
        return Err(Failure);
    }
    if method == "Target.setAutoAttach"
        && (params.get("flatten") != Some(&Value::Bool(true))
            || !params.get("autoAttach").is_some_and(Value::is_boolean)
            || !params
                .get("waitForDebuggerOnStart")
                .is_some_and(Value::is_boolean))
    {
        return Err(Failure);
    }
    Ok(())
}

impl Page {
    pub(super) fn index_bytes(&self) -> usize {
        self.frames
            .iter()
            .chain(&self.unique_contexts)
            .chain(&self.objects)
            .map(|id| id.len() + 64)
            .sum::<usize>()
            + (self.contexts.len() + self.nodes.len() + self.backend_nodes.len()) * 64
            + self
                .loaders
                .iter()
                .map(|(frame, loader)| frame.len() + loader.len() + 64)
                .sum::<usize>()
    }
    pub(super) fn validate(&self, params: &Value) -> Result<()> {
        match params {
            Value::Object(fields) => {
                for (key, value) in fields {
                    let valid = match key.as_str() {
                        "objectId" => value.as_str().is_some_and(|id| self.objects.contains(id)),
                        "frameId" => value.as_str().is_some_and(|id| self.frames.contains(id)),
                        "contextId" | "executionContextId" => {
                            value.as_i64().is_some_and(|id| self.contexts.contains(&id))
                        }
                        "uniqueContextId" => value
                            .as_str()
                            .is_some_and(|id| self.unique_contexts.contains(id)),
                        "nodeId" => value.as_i64().is_some_and(|id| self.nodes.contains(&id)),
                        "backendNodeId" => value
                            .as_i64()
                            .is_some_and(|id| self.backend_nodes.contains(&id)),
                        // CallArgument.value and evaluation source are page data, not CDP selectors.
                        "value" | "expression" | "functionDeclaration" => continue,
                        _ => {
                            self.validate(value)?;
                            true
                        }
                    };
                    if !valid {
                        return Err(Failure);
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.validate(value)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn reset_document(&mut self) {
        self.contexts.clear();
        self.unique_contexts.clear();
        self.objects.clear();
        self.nodes.clear();
        self.backend_nodes.clear();
    }

    pub(super) fn frames(&mut self, tree: &Value) -> Result<()> {
        let mut next = HashMap::new();
        Self::collect_frames(tree, &mut next)?;
        if self
            .loaders
            .iter()
            .any(|(id, loader)| next.get(id) != Some(loader))
        {
            self.reset_document();
        }
        self.frames = next.keys().cloned().collect();
        self.loaders = next;
        self.bounded()
    }

    fn collect_frames(tree: &Value, frames: &mut HashMap<String, String>) -> Result<()> {
        let frame = tree.get("frame").ok_or(Failure)?;
        let id = frame["id"].as_str().ok_or(Failure)?;
        let loader = frame["loaderId"].as_str().ok_or(Failure)?;
        frames.insert(id.to_owned(), loader.to_owned());
        if let Some(children) = tree.get("childFrames").and_then(Value::as_array) {
            for child in children {
                Self::collect_frames(child, frames)?;
            }
        }
        Ok(())
    }

    fn remote_object(&mut self, object: &Value) {
        if let Some(id) = object.get("objectId").and_then(Value::as_str) {
            self.objects.insert(id.to_owned());
        }
    }

    fn node(&mut self, node: &Value) {
        if let Some(id) = node.get("nodeId").and_then(Value::as_i64) {
            self.nodes.insert(id);
        }
        if let Some(id) = node.get("backendNodeId").and_then(Value::as_i64) {
            self.backend_nodes.insert(id);
        }
        for key in ["children", "shadowRoots", "pseudoElements"] {
            if let Some(children) = node.get(key).and_then(Value::as_array) {
                for child in children {
                    self.node(child);
                }
            }
        }
        if let Some(child) = node.get("contentDocument") {
            self.node(child);
        }
    }

    pub(super) fn learn(&mut self, method: &str, result: &Value) -> Result<()> {
        match method {
            "Runtime.evaluate" | "Runtime.callFunctionOn" => {
                self.remote_object(&result["result"]);
                if let Some(exception) = result
                    .get("exceptionDetails")
                    .and_then(|details| details.get("exception"))
                {
                    self.remote_object(exception);
                }
            }
            "DOM.resolveNode" => self.remote_object(&result["object"]),
            "Runtime.getProperties" => {
                for key in ["result", "internalProperties", "privateProperties"] {
                    if let Some(properties) = result[key].as_array() {
                        for property in properties {
                            for key in ["value", "get", "set"] {
                                self.remote_object(&property[key]);
                            }
                        }
                    }
                }
            }
            "Page.getFrameTree" => {
                self.frames(&result["frameTree"])?;
            }
            "DOM.getDocument" => self.node(&result["root"]),
            "DOM.describeNode" => self.node(&result["node"]),
            "DOM.querySelector" => {
                if let Some(id) = result["nodeId"].as_i64() {
                    self.nodes.insert(id);
                }
            }
            "DOM.querySelectorAll" => {
                if let Some(nodes) = result["nodeIds"].as_array() {
                    for id in nodes {
                        if let Some(id) = id.as_i64() {
                            self.nodes.insert(id);
                        }
                    }
                }
            }
            "Accessibility.getFullAXTree" | "Accessibility.getPartialAXTree" => {
                if let Some(nodes) = result["nodes"].as_array() {
                    for node in nodes {
                        if let Some(id) = node["backendDOMNodeId"].as_i64() {
                            self.backend_nodes.insert(id);
                        }
                    }
                }
            }
            _ => {}
        }
        self.bounded()
    }

    pub(super) fn event(&mut self, method: &str, params: &Value) -> Result<bool> {
        match method {
            "Runtime.executionContextCreated" => {
                let context = &params["context"];
                if !context
                    .get("auxData")
                    .and_then(|data| data.get("frameId"))
                    .and_then(Value::as_str)
                    .is_some_and(|id| self.frames.contains(id))
                {
                    return Ok(false);
                }
                self.contexts.insert(context["id"].as_i64().ok_or(Failure)?);
                if let Some(id) = context["uniqueId"].as_str() {
                    self.unique_contexts.insert(id.to_owned());
                }
            }
            "Runtime.executionContextsCleared" => self.reset_document(),
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = params["executionContextId"].as_i64() {
                    self.contexts.remove(&id);
                }
                self.unique_contexts.clear();
                self.objects.clear();
                self.nodes.clear();
                self.backend_nodes.clear();
            }
            "Page.frameAttached" => {
                if !params["parentFrameId"]
                    .as_str()
                    .is_some_and(|id| self.frames.contains(id))
                {
                    return Ok(false);
                }
                self.frames
                    .insert(params["frameId"].as_str().ok_or(Failure)?.to_owned());
            }
            "Page.frameDetached" => {
                if let Some(id) = params["frameId"].as_str() {
                    self.frames.remove(id);
                    self.loaders.remove(id);
                }
                self.reset_document();
            }
            "Page.frameNavigated" => {
                let frame = &params["frame"];
                if !frame["id"]
                    .as_str()
                    .is_some_and(|id| self.frames.contains(id))
                {
                    return Ok(false);
                }
                self.reset_document();
                if let (Some(id), Some(loader)) = (frame["id"].as_str(), frame["loaderId"].as_str())
                {
                    self.loaders.insert(id.to_owned(), loader.to_owned());
                }
            }
            "Runtime.consoleAPICalled"
            | "Runtime.exceptionThrown"
            | "Runtime.bindingCalled"
            | "Runtime.inspectRequested"
            | "DOM.setChildNodes"
            | "DOM.childNodeInserted"
            | "DOM.childNodeRemoved"
            | "DOM.documentUpdated" => return Ok(false),
            _ if method.starts_with("Network.")
                || matches!(
                    method,
                    "Page.loadEventFired"
                        | "Page.domContentEventFired"
                        | "Page.lifecycleEvent"
                        | "Page.frameStartedLoading"
                        | "Page.frameStoppedLoading"
                        | "Page.javascriptDialogOpening"
                        | "Page.javascriptDialogClosed"
                ) =>
            {
                if let Some(id) = params.get("frameId").and_then(Value::as_str)
                    && !self.frames.contains(id)
                {
                    return Ok(false);
                }
            }
            _ => return Ok(false),
        }
        self.bounded()?;
        Ok(true)
    }

    fn bounded(&self) -> Result<()> {
        if self.frames.len()
            + self.contexts.len()
            + self.unique_contexts.len()
            + self.objects.len()
            + self.nodes.len()
            + self.backend_nodes.len()
            > 65_536
        {
            Err(Failure)
        } else {
            Ok(())
        }
    }
}

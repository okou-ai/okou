//! Explicit cross-window capability denials and protocol-owned resource indexes.

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
    pub requests: HashSet<String>,
    pub searches: HashSet<String>,
    pub stylesheets: HashSet<String>,
    pub scripts: HashSet<String>,
}

/// Page sessions are forwarded by default. These capabilities are not confined
/// to that page, or need resource/concurrent ownership this broker does not have.
pub(super) fn blocked(method: &str) -> bool {
    let Some((domain, _)) = method.split_once('.') else {
        return true;
    };
    matches!(
        domain,
        "Browser"
            | "Target"
            | "Storage"
            | "DOMStorage"
            | "IndexedDB"
            | "CacheStorage"
            | "Database"
            | "SystemInfo"
            | "ServiceWorker"
            | "BackgroundService"
            | "Tethering"
            | "Extensions"
            | "Tracing"
            | "HeapProfiler"
            | "Profiler"
            | "Memory"
            | "IO"
            | "Fetch"
            | "Debugger"
            | "DOMDebugger"
            | "EventBreakpoints"
            | "Cast"
            | "BluetoothEmulation"
            | "WebAuthn"
            | "DeviceAccess"
            | "PWA"
    ) || matches!(
        method,
        "Page.crash"
            | "Inspector.crash"
            | "Runtime.terminateExecution"
            | "Page.setDownloadBehavior"
            | "DOM.setFileInputFiles"
            | "DOM.getFileInfo"
            | "Network.getAllCookies"
            | "Network.getCookies"
            | "Network.setCookie"
            | "Network.setCookies"
            | "Network.deleteCookies"
            | "Network.clearBrowserCookies"
            | "Network.clearBrowserCache"
            | "Network.setRequestInterception"
            | "Network.continueInterceptedRequest"
            | "Network.getResponseBodyForInterception"
            | "Network.loadNetworkResource"
            | "Security.setIgnoreCertificateErrors"
            | "Security.setOverrideCertificateErrors"
    )
}

pub(super) fn allowed(method: &str, params: &Value, session: bool) -> Result<()> {
    let fields = params.as_object().ok_or(Failure)?;
    if !session {
        // An unscoped command has no native page boundary. These handlers
        // explicitly filter their targets and results in Broker.
        let keys: &[&str] = match method {
            "Browser.getVersion" | "Target.getTargets" => &[],
            "Target.setDiscoverTargets" => &["discover"],
            "Target.attachToTarget" => &["targetId", "flatten"],
            "Target.activateTarget"
            | "Target.closeTarget"
            | "Target.getTargetInfo"
            | "Browser.getWindowForTarget" => &["targetId"],
            "Target.detachFromTarget" => &["sessionId"],
            _ => return Err(Failure),
        };
        if fields.keys().any(|key| !keys.contains(&key.as_str())) {
            return Err(Failure);
        }
    } else if method == "Target.setAutoAttach" {
        // The broker overwrites filter and permits only owned iframe children.
        if fields
            .keys()
            .any(|key| !["autoAttach", "waitForDebuggerOnStart", "flatten"].contains(&key.as_str()))
        {
            return Err(Failure);
        }
    } else if blocked(method) {
        return Err(Failure);
    }
    if method == "Input.dispatchKeyEvent" {
        keyboard(params)?;
    }
    if method == "Page.navigate"
        && let Some(url) = fields.get("url").and_then(Value::as_str)
    {
        let mut url = reqwest::Url::parse(url).map_err(|_| Failure)?;
        if url.scheme() == "view-source" {
            url = reqwest::Url::parse(url.path()).map_err(|_| Failure)?;
        }
        if matches!(
            url.scheme(),
            "file"
                | "chrome"
                | "chrome-untrusted"
                | "chrome-extension"
                | "chrome-search"
                | "chrome-native"
                | "devtools"
                | "view-source"
        ) {
            return Err(Failure);
        }
    }
    if method == "Page.createIsolatedWorld"
        && fields
            .get("grantUniveralAccess")
            .is_some_and(|value| value != &Value::Bool(false))
    {
        return Err(Failure);
    }
    if method == "Input.dispatchDragEvent"
        && fields
            .get("data")
            .and_then(|data| data.get("files"))
            .is_some_and(|files| !files.as_array().is_some_and(Vec::is_empty))
    {
        return Err(Failure);
    }
    if method == "Target.attachToTarget" && fields.get("flatten") != Some(&Value::Bool(true)) {
        return Err(Failure);
    }
    if method == "Target.setAutoAttach"
        && (fields.get("flatten") != Some(&Value::Bool(true))
            || !fields.get("autoAttach").is_some_and(Value::is_boolean)
            || !fields
                .get("waitForDebuggerOnStart")
                .is_some_and(Value::is_boolean))
    {
        return Err(Failure);
    }
    Ok(())
}

fn keyboard(params: &Value) -> Result<()> {
    let modifiers = params
        .get("modifiers")
        .map_or(Some(0), Value::as_u64)
        .ok_or(Failure)?;
    if modifiers > 15 {
        return Err(Failure);
    }
    let virtual_key = params
        .get("windowsVirtualKeyCode")
        .map(|v| v.as_u64().ok_or(Failure))
        .transpose()?;
    let native_key = params
        .get("nativeVirtualKeyCode")
        .map(|v| v.as_u64().ok_or(Failure))
        .transpose()?;
    if native_key.is_some() && native_key != virtual_key {
        return Err(Failure);
    }
    // Check every supplied encoding; a benign key name cannot hide a browser
    // accelerator in code or a native virtual-key value.
    let mut keys = Vec::new();
    for field in ["key", "code"] {
        if let Some(value) = params.get(field) {
            let key = value.as_str().ok_or(Failure)?.to_ascii_lowercase();
            keys.push(key.strip_prefix("key").unwrap_or(&key).to_owned());
        }
    }
    if let Some(key) = virtual_key {
        if (112..=135).contains(&key) {
            keys.push(format!("f{}", key - 111));
        } else if (166..=183).contains(&key) {
            return Err(Failure);
        } else if (65..=90).contains(&key) {
            keys.push(
                char::from_u32(u32::try_from(key + 32).map_err(|_| Failure)?)
                    .ok_or(Failure)?
                    .to_string(),
            );
        } else if (48..=57).contains(&key) {
            keys.push(format!("digit{}", key - 48));
        } else if let Some(key) = match key {
            8 => Some("backspace"),
            9 => Some("tab"),
            32 => Some("space"),
            36 => Some("home"),
            46 => Some("delete"),
            187 => Some("equal"),
            189 => Some("minus"),
            _ => None,
        } {
            keys.push(key.to_owned());
        }
    }
    let control = modifiers & 6 != 0;
    let shift = modifiers & 8 != 0;
    let alt = modifiers & 1 != 0;
    if keys.iter().any(|key| {
        key.starts_with("browser")
            || matches!(
                key.as_str(),
                "f1" | "f3" | "f4" | "f5" | "f6" | "f7" | "f10" | "f11" | "f12"
            )
            || control
                && matches!(
                    key.as_str(),
                    "b" | "d"
                        | "e"
                        | "f"
                        | "g"
                        | "h"
                        | "j"
                        | "k"
                        | "l"
                        | "n"
                        | "o"
                        | "p"
                        | "q"
                        | "r"
                        | "s"
                        | "t"
                        | "u"
                        | "w"
                        | "tab"
                        | "pageup"
                        | "pagedown"
                        | "digit0"
                        | "digit1"
                        | "digit2"
                        | "digit3"
                        | "digit4"
                        | "digit5"
                        | "digit6"
                        | "digit7"
                        | "digit8"
                        | "digit9"
                        | "0"
                        | "1"
                        | "2"
                        | "3"
                        | "4"
                        | "5"
                        | "6"
                        | "7"
                        | "8"
                        | "9"
                        | "equal"
                        | "+"
                        | "minus"
                        | "-"
                )
            || control && shift && matches!(key.as_str(), "a" | "c" | "i" | "m" | "delete")
            || alt
                && matches!(
                    key.as_str(),
                    "d" | "e" | "f" | "home" | "space" | " " | "tab" | "arrowleft" | "arrowright"
                )
    }) {
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
            .chain(&self.requests)
            .chain(&self.searches)
            .chain(&self.stylesheets)
            .chain(&self.scripts)
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
                        "objectId" | "prototypeObjectId" | "errorObjectId" | "promiseObjectId" => {
                            value.as_str().is_some_and(|id| self.objects.contains(id))
                        }
                        "frameId" => value.as_str().is_some_and(|id| self.frames.contains(id)),
                        "targetId" => value.as_str() == Some(self.target.as_str()),
                        "browserContextId" | "sessionId" | "interceptionId" => false,
                        "requestId" => value.as_str().is_some_and(|id| self.requests.contains(id)),
                        "searchId" => value.as_str().is_some_and(|id| self.searches.contains(id)),
                        "styleSheetId" => value
                            .as_str()
                            .is_some_and(|id| self.stylesheets.contains(id)),
                        "scriptId" => value.as_str().is_some_and(|id| self.scripts.contains(id)),
                        "contextId" | "executionContextId" => {
                            value.as_i64().is_some_and(|id| self.contexts.contains(&id))
                        }
                        "uniqueContextId" => value
                            .as_str()
                            .is_some_and(|id| self.unique_contexts.contains(id)),
                        "nodeId" | "targetNodeId" | "insertBeforeNodeId" => {
                            value.as_i64().is_some_and(|id| self.nodes.contains(&id))
                        }
                        "backendNodeId" | "fieldId" => value
                            .as_i64()
                            .is_some_and(|id| self.backend_nodes.contains(&id)),
                        "backendNodeIds" => value.as_array().is_some_and(|ids| {
                            ids.iter().all(|id| {
                                id.as_i64()
                                    .is_some_and(|id| self.backend_nodes.contains(&id))
                            })
                        }),
                        "nodeIds" => value.as_array().is_some_and(|ids| {
                            ids.iter()
                                .all(|id| id.as_i64().is_some_and(|id| self.nodes.contains(&id)))
                        }),
                        "frameIds" => value.as_array().is_some_and(|ids| {
                            ids.iter()
                                .all(|id| id.as_str().is_some_and(|id| self.frames.contains(id)))
                        }),
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
        self.requests.clear();
        self.searches.clear();
        self.stylesheets.clear();
        self.scripts.clear();
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
            "Runtime.evaluate"
            | "Runtime.callFunctionOn"
            | "Runtime.awaitPromise"
            | "Runtime.runScript" => {
                self.remote_object(&result["result"]);
                if let Some(exception) = result
                    .get("exceptionDetails")
                    .and_then(|details| details.get("exception"))
                {
                    self.remote_object(exception);
                }
            }
            "DOM.resolveNode" => self.remote_object(&result["object"]),
            "Runtime.queryObjects" => self.remote_object(&result["objects"]),
            "Page.createIsolatedWorld" => {
                self.contexts
                    .insert(result["executionContextId"].as_i64().ok_or(Failure)?);
            }
            "DOM.performSearch" => {
                self.searches
                    .insert(result["searchId"].as_str().ok_or(Failure)?.to_owned());
            }
            "Runtime.compileScript" => {
                if let Some(id) = result.get("scriptId").and_then(Value::as_str) {
                    self.scripts.insert(id.to_owned());
                }
            }
            "CSS.createStyleSheet" => {
                self.stylesheets
                    .insert(result["styleSheetId"].as_str().ok_or(Failure)?.to_owned());
            }
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
            "DOM.querySelector"
            | "DOM.requestNode"
            | "DOM.pushNodeByPathToFrontend"
            | "DOM.getNodeForLocation" => {
                if let Some(id) = result["nodeId"].as_i64() {
                    self.nodes.insert(id);
                }
                if let Some(id) = result.get("backendNodeId").and_then(Value::as_i64) {
                    self.backend_nodes.insert(id);
                }
            }
            "DOM.querySelectorAll"
            | "DOM.getSearchResults"
            | "DOM.pushNodesByBackendIdsToFrontend" => {
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
        if blocked(method)
            || params
                .get("targetId")
                .is_some_and(|id| id.as_str() != Some(self.target.as_str()))
            || params.get("browserContextId").is_some()
            || method != "Page.frameAttached"
                && params
                    .get("frameId")
                    .is_some_and(|id| !id.as_str().is_some_and(|id| self.frames.contains(id)))
            || params
                .get("executionContextId")
                .is_some_and(|id| !id.as_i64().is_some_and(|id| self.contexts.contains(&id)))
        {
            return Ok(false);
        }
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
                let id = params["executionContextId"].as_i64().ok_or(Failure)?;
                if !self.contexts.remove(&id) {
                    return Ok(false);
                }
                self.unique_contexts.clear();
                self.objects.clear();
                self.nodes.clear();
                self.backend_nodes.clear();
                self.scripts.clear();
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
                let id = params["frameId"].as_str().ok_or(Failure)?;
                if !self.frames.remove(id) {
                    return Ok(false);
                }
                self.loaders.remove(id);
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
            "Runtime.consoleAPICalled" => {
                if let Some(arguments) = params["args"].as_array() {
                    for object in arguments {
                        self.remote_object(object);
                    }
                }
            }
            "Runtime.exceptionThrown" => {
                let details = &params["exceptionDetails"];
                if details
                    .get("executionContextId")
                    .is_some_and(|id| !id.as_i64().is_some_and(|id| self.contexts.contains(&id)))
                {
                    return Ok(false);
                }
                self.remote_object(&details["exception"]);
            }
            "Runtime.inspectRequested" => self.remote_object(&params["object"]),
            "DOM.setChildNodes" => {
                if !params["parentId"]
                    .as_i64()
                    .is_some_and(|id| self.nodes.contains(&id))
                {
                    return Ok(false);
                }
                if let Some(nodes) = params["nodes"].as_array() {
                    for node in nodes {
                        self.node(node);
                    }
                }
            }
            "DOM.childNodeInserted" => {
                if !params["parentNodeId"]
                    .as_i64()
                    .is_some_and(|id| self.nodes.contains(&id))
                {
                    return Ok(false);
                }
                self.node(&params["node"]);
            }
            "DOM.childNodeRemoved" => {
                if !params["parentNodeId"]
                    .as_i64()
                    .is_some_and(|id| self.nodes.contains(&id))
                    || !params["nodeId"]
                        .as_i64()
                        .is_some_and(|id| self.nodes.remove(&id))
                {
                    return Ok(false);
                }
            }
            "DOM.documentUpdated" => {
                self.nodes.clear();
                self.backend_nodes.clear();
                self.searches.clear();
            }
            "CSS.styleSheetAdded" => {
                let header = &params["header"];
                if !header["frameId"]
                    .as_str()
                    .is_some_and(|id| self.frames.contains(id))
                {
                    return Ok(false);
                }
                self.stylesheets
                    .insert(header["styleSheetId"].as_str().ok_or(Failure)?.to_owned());
            }
            "CSS.styleSheetRemoved"
                if !params["styleSheetId"]
                    .as_str()
                    .is_some_and(|id| self.stylesheets.remove(id)) =>
            {
                return Ok(false);
            }
            _ => {}
        }
        if method.starts_with("Network.")
            && let Some(id) = params.get("requestId").and_then(Value::as_str)
        {
            self.requests.insert(id.to_owned());
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
            + self.requests.len()
            + self.searches.len()
            + self.stylesheets.len()
            + self.scripts.len()
            > 65_536
        {
            Err(Failure)
        } else {
            Ok(())
        }
    }
}

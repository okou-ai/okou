//! One scoped inspector; runtime indexes never replace current native ownership.

use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

use super::{
    Failure, Result,
    authority::Scope,
    client::Client,
    policy::{self, Page},
};

pub(super) struct Broker {
    pub client: Client,
    pub scope: Scope,
    sessions: HashMap<String, Page>,
    targets: HashSet<String>,
    discover: bool,
}

impl Broker {
    fn bounded(&self) -> Result<()> {
        let bytes = self.targets.iter().map(|id| id.len() + 64).sum::<usize>()
            + self
                .sessions
                .iter()
                .map(|(id, page)| id.len() + page.target.len() + 64 + page.index_bytes())
                .sum::<usize>();
        if bytes > 8 * 1024 * 1024 || self.sessions.len() > 256 {
            Err(Failure)
        } else {
            Ok(())
        }
    }
    pub(super) fn new(client: Client, scope: Scope) -> Self {
        Self {
            client,
            scope,
            sessions: HashMap::new(),
            targets: HashSet::new(),
            discover: false,
        }
    }

    async fn window_id(&self, target: &str) -> Result<u64> {
        let result = self
            .client
            .command(
                "Browser.getWindowForTarget",
                json!({"targetId":target}),
                None,
            )
            .await?;
        result
            .get("windowId")
            .and_then(Value::as_u64)
            .ok_or(Failure)
    }

    async fn window(&self, target: &str) -> Result<()> {
        if self.window_id(target).await? == self.scope.window {
            Ok(())
        } else {
            Err(Failure)
        }
    }

    pub(super) async fn verify_sessions(&self) -> Result<()> {
        let mut checked = HashSet::new();
        for page in self.sessions.values() {
            if checked.insert(&page.target) {
                self.window(&page.target).await?;
            }
        }
        Ok(())
    }

    async fn discovery(&mut self) -> Result<Value> {
        let result = self
            .client
            .command("Target.getTargets", json!({}), None)
            .await?;
        let infos = result
            .get("targetInfos")
            .and_then(Value::as_array)
            .ok_or(Failure)?;
        let mut owned = Vec::new();
        let mut targets = HashSet::new();
        for info in infos {
            if info["type"] != "page" {
                continue;
            }
            let target = info["targetId"].as_str().ok_or(Failure)?;
            if self.window_id(target).await? == self.scope.window {
                targets.insert(target.to_owned());
                owned.push(target_info(info)?);
            }
        }
        self.targets = targets;
        self.sessions
            .retain(|_, page| self.targets.contains(&page.target));
        self.bounded()?;
        Ok(json!({"targetInfos":owned}))
    }

    async fn prepare_page(&mut self, session: &str) -> Result<()> {
        let page = self.sessions.get(session).ok_or(Failure)?;
        self.window(&page.target).await?;
        let tree = self
            .client
            .command("Page.getFrameTree", json!({}), Some(session))
            .await?;
        self.window(&page.target).await?;
        let page = self.sessions.get_mut(session).ok_or(Failure)?;
        page.frames(tree.get("frameTree").ok_or(Failure)?)
    }

    pub(super) async fn dispatch(&mut self, input: Value) -> Result<Value> {
        let id = input
            .get("id")
            .and_then(Value::as_u64)
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or(Failure)?;
        let method = input.get("method").and_then(Value::as_str).ok_or(Failure)?;
        let session = input
            .get("sessionId")
            .map(|s| s.as_str().ok_or(Failure))
            .transpose()?;
        let denied = || {
            let mut response = serde_json::Map::from_iter([
                ("id".to_owned(), id.into()),
                (
                    "error".to_owned(),
                    json!({"code":-32601,"message":"Operation unavailable in this chat window"}),
                ),
            ]);
            if let Some(session) = session {
                response.insert("sessionId".to_owned(), session.into());
            }
            Value::Object(response)
        };
        let mut params = input.get("params").cloned().unwrap_or_else(|| json!({}));
        let released_object = if method == "Runtime.releaseObject" {
            params
                .get("objectId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            None
        };
        if input
            .as_object()
            .ok_or(Failure)?
            .keys()
            .any(|key| !["id", "method", "params", "sessionId"].contains(&key.as_str()))
            || policy::allowed(method, &params, session.is_some()).is_err()
        {
            return Ok(denied());
        }
        if let Some(session) = session {
            if !self.sessions.contains_key(session) {
                return Ok(denied());
            }
            self.prepare_page(session).await?;
            if self
                .sessions
                .get(session)
                .ok_or(Failure)?
                .validate(&params)
                .is_err()
            {
                return Ok(denied());
            }
        }
        let result = match (session, method) {
            (None, "Target.getTargets") => self.discovery().await?,
            (None, "Target.setDiscoverTargets") => {
                self.discover = params
                    .get("discover")
                    .and_then(Value::as_bool)
                    .ok_or(Failure)?;
                self.client.command(method, params, None).await?
            }
            (
                None,
                "Target.attachToTarget"
                | "Target.activateTarget"
                | "Target.closeTarget"
                | "Target.getTargetInfo"
                | "Browser.getWindowForTarget",
            ) => {
                let target = params
                    .get("targetId")
                    .and_then(Value::as_str)
                    .ok_or(Failure)?
                    .to_owned();
                if !self.targets.contains(&target) {
                    return Ok(denied());
                }
                self.window(&target).await?;
                let result = self.client.command(method, params, None).await?;
                match method {
                    "Target.attachToTarget" => {
                        if self.sessions.len() >= 256 {
                            return Err(Failure);
                        }
                        let session = result
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .ok_or(Failure)?
                            .to_owned();
                        if self.sessions.contains_key(&session) {
                            return Err(Failure);
                        }
                        self.sessions.insert(
                            session.clone(),
                            Page {
                                target,
                                ..Page::default()
                            },
                        );
                        self.prepare_page(&session).await?;
                    }
                    "Target.getTargetInfo" => {
                        self.window(&target).await?;
                        let info = result.get("targetInfo").ok_or(Failure)?;
                        if info.get("targetId").and_then(Value::as_str) != Some(target.as_str())
                            || info.get("type").and_then(Value::as_str) != Some("page")
                        {
                            return Err(Failure);
                        }
                        return Ok(json!({"id":id,"result":{"targetInfo":target_info(info)?}}));
                    }
                    "Browser.getWindowForTarget" => {
                        if result.get("windowId").and_then(Value::as_u64) != Some(self.scope.window)
                        {
                            return Err(Failure);
                        }
                        return Ok(
                            json!({"id":id,"result":{"windowId":self.scope.window,"bounds":result.get("bounds").ok_or(Failure)?}}),
                        );
                    }
                    "Target.closeTarget" => {
                        self.targets.remove(&target);
                        self.sessions.retain(|_, page| page.target != target);
                    }
                    _ => {}
                }
                result
            }
            (None, "Target.detachFromTarget") => {
                let session = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or(Failure)?
                    .to_owned();
                let Some(page) = self.sessions.get(&session) else {
                    return Ok(denied());
                };
                self.window(&page.target).await?;
                let result = self.client.command(method, params, None).await?;
                self.sessions.remove(&session);
                result
            }
            (Some(_), "Target.setAutoAttach") => {
                // Upstream can pause only descendant iframes of this verified page.
                // A catch-all exclusion prevents worker/global attachment.
                params.as_object_mut().ok_or(Failure)?.insert(
                    "filter".to_owned(),
                    json!([{"type":"iframe","exclude":false},{"exclude":true}]),
                );
                self.client.command(method, params, session).await?
            }
            (None, "Browser.getVersion") => {
                let version = self.client.command(method, params, None).await?;
                let mut safe = serde_json::Map::new();
                for key in [
                    "protocolVersion",
                    "product",
                    "revision",
                    "userAgent",
                    "jsVersion",
                ] {
                    safe.insert(key.to_owned(), version.get(key).ok_or(Failure)?.clone());
                }
                Value::Object(safe)
            }
            _ => {
                let mut response = self.client.response(method, params, session).await?;
                if let Some(error) = response.get("error") {
                    if let Some(session) = session {
                        self.window(&self.sessions.get(session).ok_or(Failure)?.target)
                            .await?;
                    }
                    let mut response = denied();
                    let safe_error = response
                        .get_mut("error")
                        .and_then(Value::as_object_mut)
                        .ok_or(Failure)?;
                    safe_error.insert(
                        "code".to_owned(),
                        error
                            .get("code")
                            .and_then(Value::as_i64)
                            .ok_or(Failure)?
                            .into(),
                    );
                    safe_error.insert("message".to_owned(), "CDP command failed".into());
                    return Ok(response);
                }
                response
                    .as_object_mut()
                    .ok_or(Failure)?
                    .remove("result")
                    .ok_or(Failure)?
            }
        };
        if let Some(session) = session {
            let page = self.sessions.get_mut(session).ok_or(Failure)?;
            page.learn(method, &result)?;
            if let Some(id) = released_object {
                page.objects.remove(&id);
            }
            self.window(&self.sessions.get(session).ok_or(Failure)?.target)
                .await?;
        }
        let mut response = serde_json::Map::from_iter([
            ("id".to_owned(), id.into()),
            ("result".to_owned(), result),
        ]);
        self.bounded()?;
        if let Some(session) = session {
            response.insert("sessionId".to_owned(), session.into());
        }
        Ok(Value::Object(response))
    }

    pub(super) async fn event(&mut self, mut event: Value) -> Result<Option<Value>> {
        let method = event.get("method").and_then(Value::as_str).ok_or(Failure)?;
        let params = event
            .get("params")
            .filter(|params| params.is_object())
            .ok_or(Failure)?;
        if let Some(session) = event.get("sessionId").and_then(Value::as_str) {
            let Some(page) = self.sessions.get(session) else {
                return Ok(None);
            };
            self.window(&page.target).await?;
            if method == "Target.attachedToTarget" {
                let child = params["sessionId"].as_str().ok_or(Failure)?.to_owned();
                let info = params.get("targetInfo").ok_or(Failure)?;
                let frame = info
                    .get("targetId")
                    .and_then(Value::as_str)
                    .ok_or(Failure)?
                    .to_owned();
                let target = page.target.clone();
                self.prepare_page(session).await?;
                if info.get("type").and_then(Value::as_str) != Some("iframe")
                    || !self
                        .sessions
                        .get(session)
                        .ok_or(Failure)?
                        .frames
                        .contains(&frame)
                    || self.sessions.contains_key(&child)
                {
                    self.client
                        .command(
                            "Target.detachFromTarget",
                            json!({"sessionId":child}),
                            Some(session),
                        )
                        .await?;
                    return Ok(None);
                }
                self.sessions.insert(
                    child.clone(),
                    Page {
                        target,
                        frames: HashSet::from([frame]),
                        ..Page::default()
                    },
                );
                self.bounded()?;
                return Ok(Some(
                    json!({"method":method,"sessionId":session,"params":{"sessionId":child,"targetInfo":target_info(&params["targetInfo"])?,"waitingForDebugger":params["waitingForDebugger"]}}),
                ));
            }
            if method == "Target.detachedFromTarget" {
                let child = params["sessionId"].as_str().ok_or(Failure)?;
                if self.sessions.remove(child).is_none() {
                    return Ok(None);
                }
                return Ok(Some(
                    json!({"method":method,"sessionId":session,"params":{"sessionId":child}}),
                ));
            }
            if !self
                .sessions
                .get_mut(session)
                .ok_or(Failure)?
                .event(method, params)?
            {
                return Ok(None);
            }
            self.bounded()?;
            let method = method.to_owned();
            let session = session.to_owned();
            let params = event.get_mut("params").ok_or(Failure)?.take();
            return Ok(Some(Value::Object(serde_json::Map::from_iter([
                ("method".to_owned(), method.into()),
                ("sessionId".to_owned(), session.into()),
                ("params".to_owned(), params),
            ]))));
        }
        match method {
            "Target.targetCreated" | "Target.targetInfoChanged" if self.discover => {
                let info = &params["targetInfo"];
                let target = info["targetId"].as_str().ok_or(Failure)?;
                if info["type"] != "page" || self.window_id(target).await? != self.scope.window {
                    return Ok(None);
                }
                self.targets.insert(target.to_owned());
                self.bounded()?;
                Ok(Some(
                    json!({"method":method,"params":{"targetInfo":target_info(info)?}}),
                ))
            }
            "Target.targetDestroyed" if self.discover => {
                let target = params["targetId"].as_str().ok_or(Failure)?;
                if !self.targets.remove(target) {
                    return Ok(None);
                }
                self.sessions.retain(|_, page| page.target != target);
                Ok(Some(json!({"method":method,"params":{"targetId":target}})))
            }
            _ => Ok(None),
        }
    }
}

fn target_info(info: &Value) -> Result<Value> {
    Ok(
        json!({"targetId":info["targetId"].as_str().ok_or(Failure)?,"type":info["type"].as_str().ok_or(Failure)?,
        "title":info["title"].as_str().ok_or(Failure)?,"url":info["url"].as_str().ok_or(Failure)?,"attached":info["attached"].as_bool().ok_or(Failure)?,"canAccessOpener":false}),
    )
}

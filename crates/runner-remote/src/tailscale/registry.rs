//! Configuration ownership is subordinate to one exact production cache registration.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use super::domain::{Completion, Failure, Pool, Work};
use super::{configuration::Configuration, provisioning_effect::Journal};

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub(crate) struct Key {
    pub(super) configuration: uuid::Uuid,
    pub(super) generation: i64,
}

pub(crate) struct Node {
    completion: Arc<Completion>,
}

impl Node {
    pub(crate) fn start(&self) {
        self.completion.start();
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) async fn ready(&self) -> Result<(), Failure> {
        self.completion.ready().await
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) async fn physical(&self) -> Result<(), Failure> {
        self.completion.physical().await
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(crate) async fn dial(
        &self,
        target: &str,
        port: u16,
    ) -> Result<super::tcp::Stream, Failure> {
        self.completion.ready().await?;
        self.completion.client()?.dial(target, port)?.await
    }

    pub(crate) async fn dial_retained(
        &self,
        target: &str,
        port: u16,
        lease: super::Lease,
    ) -> Result<super::tcp::Stream, Failure> {
        self.completion.ready().await?;
        self.completion
            .client()?
            .dial_retained(target, port, Some(lease))?
            .await
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.completion.cancel();
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    failed: Option<Failure>,
    nodes: HashMap<Key, Weak<Node>>,
    physical: Vec<Arc<Completion>>,
    previous: Vec<Arc<Completion>>,
}

#[derive(Default)]
struct Effects {
    state: Mutex<EffectState>,
}

#[derive(Default)]
struct EffectState {
    entries: HashMap<Key, Arc<Journal>>,
    failed: Option<Failure>,
}

pub(crate) struct Registry {
    pool: Arc<Pool>,
    state: Mutex<State>,
    effects: Arc<Effects>,
}

impl Registry {
    pub(crate) fn new(pool: Arc<Pool>) -> Self {
        Self::with_effects(pool, Arc::new(Effects::default()))
    }

    fn with_effects(pool: Arc<Pool>, effects: Arc<Effects>) -> Self {
        Self {
            pool,
            state: Mutex::new(State::default()),
            effects,
        }
    }

    pub(crate) fn replacement(pool: Arc<Pool>, previous: &Self) -> Self {
        previous.close();
        let old = previous.state.lock().unwrap_or_else(|p| p.into_inner());
        let effects = Arc::clone(&previous.effects);
        let mut pending = Vec::new();
        let mut failed = old.failed;
        for completion in old.previous.iter().chain(&old.physical) {
            match completion.physical_result() {
                Some(Ok(())) => {}
                Some(Err(failure)) => {
                    failed.get_or_insert(failure);
                }
                None if !pending.iter().any(|held| Arc::ptr_eq(held, completion)) => {
                    pending.push(Arc::clone(completion))
                }
                None => {}
            }
        }
        if let Some(failure) = failed {
            effects
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .failed
                .get_or_insert(failure);
        }
        Self {
            pool,
            effects,
            state: Mutex::new(State {
                previous: pending,
                failed,
                ..State::default()
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn acquire(&self, key: Key, work: Work) -> Result<Arc<Node>, Failure> {
        self.acquire_with(key, |_| Ok((work, None)))
    }

    pub(crate) fn acquire_configured(
        &self,
        configuration: Configuration,
        factory: impl FnOnce(Configuration, Arc<Journal>) -> Work,
    ) -> Result<Arc<Node>, Failure> {
        let key = configuration.key();
        self.acquire_with(key, |state| {
            let mut effects = self.effects.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(failure) = state
                .previous
                .iter()
                .find_map(|item| item.physical_result().and_then(Result::err))
            {
                effects.failed.get_or_insert(failure);
            }
            if let Some(failure) = effects.failed {
                return Err(failure);
            }
            if state
                .previous
                .iter()
                .any(|item| !item.physically_finished())
            {
                return Err(Failure::DomainFailed);
            }
            state.previous.clear();
            if effects
                .entries
                .values()
                .any(|journal| journal.physical_failed())
            {
                return Err(Failure::DomainFailed);
            }
            if effects
                .entries
                .get(&key)
                .is_some_and(|journal| !journal.retry_safe())
            {
                return Err(Failure::DomainFailed);
            }
            // Same-Run registration replacement keeps the receipt, including
            // an unfinished physical owner, after the weak node disappears.
            if !effects.entries.contains_key(&key) && effects.entries.len() >= 64 {
                return Err(Failure::ResourceExhausted);
            }
            let journal = Arc::new(Journal::new());
            let work = factory(configuration, Arc::clone(&journal));
            effects.entries.insert(key, Arc::clone(&journal));
            Ok((work, Some(journal)))
        })
    }

    fn acquire_with(
        &self,
        key: Key,
        factory: impl FnOnce(&mut State) -> Result<(Work, Option<Arc<Journal>>), Failure>,
    ) -> Result<Arc<Node>, Failure> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(failure) = state.failed {
            return Err(failure);
        }
        if state.closed {
            return Err(Failure::Cancelled);
        }
        if let Some(node) = state.nodes.get(&key).and_then(Weak::upgrade) {
            if node.completion.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            return Ok(node);
        }
        if let Some(failure) = state
            .physical
            .iter()
            .find_map(|item| item.physical_result().and_then(Result::err))
        {
            state.failed = Some(failure);
            return Err(failure);
        }
        state.nodes.retain(|_, node| node.strong_count() != 0);
        state
            .physical
            .retain(|completion| !completion.physically_finished());
        let (work, journal) = factory(&mut state)?;
        let completion = match self.pool.allocate(work, journal.clone()) {
            Ok(completion) => completion,
            Err(failure) => {
                if let Some(journal) = journal {
                    journal.finished(Ok(()));
                }
                return Err(failure);
            }
        };
        // Both the actual thread join and this Run's cleanup receipt exist before startup.
        state.physical.push(Arc::clone(&completion));
        let node = Arc::new(Node { completion });
        state.nodes.insert(key, Arc::downgrade(&node));
        Ok(node)
    }

    pub(crate) fn invalidate(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        for completion in &state.physical {
            completion.cancel();
        }
        state.nodes.clear();
    }

    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closed = true;
        for completion in &state.physical {
            completion.cancel();
        }
    }

    pub(crate) async fn shutdown(&self) -> Result<(), Failure> {
        self.close();
        let completions = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(failure) = self
                .effects
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .failed
            {
                state.failed.get_or_insert(failure);
            }
            if let Some(failure) = state.failed {
                return Err(failure);
            }
            state
                .previous
                .iter()
                .chain(&state.physical)
                .cloned()
                .collect::<Vec<_>>()
        };
        let retirement = async {
            let results =
                futures_util::future::join_all(completions.iter().map(|item| item.physical()))
                    .await;
            results
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map(|_| ())
        };
        let result = tokio::time::timeout(Duration::from_secs(5), retirement)
            .await
            .unwrap_or(Err(Failure::CleanupTimedOut));
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        // Late physical completion never converts an earlier failed cleanup into success.
        if let Err(failure) = result {
            state.failed.get_or_insert(failure);
            self.effects
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .failed
                .get_or_insert(failure);
        }
        state.failed.map_or(result, Err)
    }
}

impl Drop for Registry {
    fn drop(&mut self) {
        self.close();
    }
}

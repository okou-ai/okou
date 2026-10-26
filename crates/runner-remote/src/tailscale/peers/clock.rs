//! Key-expiry time shared by admission and retained ciphertext.

use chrono::{DateTime, Utc};

#[derive(Clone, Default)]
pub(in crate::tailscale) struct Clock {
    #[cfg(test)]
    held: Option<Held>,
}

#[cfg(test)]
#[derive(Clone)]
struct Held {
    origin: DateTime<Utc>,
    started: tokio::sync::watch::Sender<Option<std::time::Instant>>,
}

impl Clock {
    pub(in crate::tailscale) fn now(&self) -> DateTime<Utc> {
        #[cfg(test)]
        if let Some(held) = &self.held {
            return held
                .started
                .borrow()
                .map_or(held.origin, |started| held.origin + started.elapsed());
        }
        Utc::now()
    }

    pub(in crate::tailscale) async fn wait_until(&self, expires: DateTime<Utc>) {
        #[cfg(test)]
        if let Some(held) = &self.held {
            let mut started = held.started.subscribe();
            // This Clock retains a sender, so the channel cannot close while
            // waiting. Preparation cannot consume the natural expiry interval.
            let _ = started.wait_for(Option::is_some).await;
        }
        let remaining = (expires - self.now()).to_std().unwrap_or_default();
        tokio::time::sleep(remaining).await;
    }

    #[cfg(test)]
    pub(in crate::tailscale) fn held() -> Self {
        Self {
            held: Some(Held {
                origin: Utc::now(),
                started: tokio::sync::watch::channel(None).0,
            }),
        }
    }

    #[cfg(test)]
    pub(in crate::tailscale) fn start(&self) {
        let held = self.held.as_ref().unwrap();
        assert!(
            held.started
                .send_replace(Some(std::time::Instant::now()))
                .is_none(),
            "the fixture starts its expiry phase only once"
        );
    }
}

use std::future::pending;
use std::io;
use std::sync::{Arc, Mutex};

use tokio::net::UnixStream;
use tokio::sync::oneshot;

use super::writing::{Kind, Writer};
use super::{
    ArmState, ConnectionProducer, Controls, Exchange, ExchangeProducer, Frame, RequestKind,
    ResponseDisposition, framing,
};

pub(super) fn start(
    host: UnixStream,
    guest: UnixStream,
) -> (Controls, ExchangeProducer, ConnectionProducer) {
    let arm = Arc::new(Mutex::new(ArmState::Waiting));
    let (captured_tx, captured) = oneshot::channel();
    let (dispatch, dispatch_rx) = oneshot::channel();
    let (response_tx, response) = oneshot::channel();
    let (delivery, delivery_rx) = oneshot::channel();
    let (exchange_tx, exchange_rx) = oneshot::channel();
    let (host_read, host_write) = host.into_split();
    let (guest_read, guest_write) = guest.into_split();
    let mut relay = Relay {
        arm: Arc::clone(&arm),
        host: framing::Reader::new(host_read),
        guest: framing::Reader::new(guest_read),
        host_write: Writer::new(host_write),
        guest_write: Writer::new(guest_write),
        captured: Some(captured_tx),
        response: Some(response_tx),
        exchange: Some(exchange_tx),
        dispatch: Some(dispatch_rx),
        delivery: Some(delivery_rx),
        selected: None,
        held_request: None,
        held_response: None,
        host_eof: false,
        guest_eof: false,
        host_write_failed: false,
        guest_write_failed: false,
        error: None,
    };
    let task = tokio::spawn(async move {
        let result = relay.run().await;
        if let Some(exchange) = relay.exchange.take() {
            let error = match &result {
                Err(error) => copy_error(error),
                Ok(()) => io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Guest connection ended without the selected exchange",
                ),
            };
            let _ = exchange.send(Err(error));
        }
        result
    });
    (
        Controls {
            arm,
            captured,
            dispatch,
            response,
            delivery,
        },
        ExchangeProducer {
            result: Some(exchange_rx),
        },
        ConnectionProducer { task: Some(task) },
    )
}

struct Selected {
    kind: RequestKind,
    request: Frame,
    dispatched: bool,
    completed: bool,
}

struct Relay {
    arm: Arc<Mutex<ArmState>>,
    host: framing::Reader,
    guest: framing::Reader,
    host_write: Writer,
    guest_write: Writer,
    captured: Option<oneshot::Sender<Frame>>,
    response: Option<oneshot::Sender<Frame>>,
    exchange: Option<oneshot::Sender<io::Result<Exchange>>>,
    dispatch: Option<oneshot::Receiver<()>>,
    delivery: Option<oneshot::Receiver<ResponseDisposition>>,
    selected: Option<Selected>,
    held_request: Option<Frame>,
    held_response: Option<Frame>,
    host_eof: bool,
    guest_eof: bool,
    host_write_failed: bool,
    guest_write_failed: bool,
    error: Option<io::Error>,
}

impl Relay {
    fn capture_kind(&self, frame: &Frame) -> io::Result<Option<RequestKind>> {
        let mut state = self
            .arm
            .lock()
            .map_err(|_| io::Error::other("Guest request gate arm poisoned"))?;
        if let ArmState::Armed(kind) = *state
            && frame.message_type() == kind.request_type()
        {
            if frame.sequence() == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "selected Guest request has no sequence",
                ));
            }
            *state = ArmState::Captured;
            Ok(Some(kind))
        } else {
            Ok(None)
        }
    }

    fn record_error(&mut self, error: io::Error) {
        if self.error.is_none() {
            self.error = Some(error);
        }
    }

    fn complete_exchange(&mut self, response: Frame, delivery: io::Result<()>) -> io::Result<()> {
        let delivery = delivery.and_then(|()| match &self.error {
            Some(error) => Err(copy_error(error)),
            None => Ok(()),
        });
        let selected = self
            .selected
            .as_mut()
            .ok_or_else(|| io::Error::other("selected Guest request absent"))?;
        selected.completed = true;
        let result = delivery.map(|()| Exchange {
            request: selected.request.clone(),
            response,
        });
        if let Some(exchange) = self.exchange.take() {
            let _ = exchange.send(result);
        }
        Ok(())
    }

    async fn run(&mut self) -> io::Result<()> {
        loop {
            if self.guest_eof
                && self.held_response.is_none()
                && self.host_write.is_idle()
                && self.guest_write.is_idle()
            {
                if self.selected.as_ref().is_some_and(|s| !s.completed) {
                    return Err(self.error.take().unwrap_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "Guest peer ended before selected terminal delivery",
                        )
                    }));
                }
                if let Err(error) = self.host_write.shutdown().await {
                    self.record_error(error);
                }
                return self.error.take().map_or(Ok(()), Err);
            }
            tokio::select! {
                frame = self.host.next(), if !self.host_eof && !self.guest_eof && !self.guest_write_failed && self.guest_write.is_idle() => {
                    let frame = match frame {
                        Ok(frame) => frame,
                        Err(error) if self.selected.is_some() => {
                            // A cancelled Host write can end inside another frame.
                            // Retain the selected work and report the original fault
                            // after its real terminal has drained.
                            self.record_error(error);
                            None
                        }
                        Err(error) => return Err(error),
                    };
                    let Some(frame) = frame else {
                        // Do not close the Guest's input and cancel accepted work.
                        self.host_eof = true;
                        continue;
                    };
                    if let Some(kind) = self.capture_kind(&frame)? {
                        if let Some(captured) = self.captured.take() {
                            let _ = captured.send(frame.clone());
                        }
                        self.selected = Some(Selected { kind, request: frame.clone(), dispatched: false, completed: false });
                        self.held_request = Some(frame);
                    } else {
                        self.guest_write.queue(frame, Kind::Forward)?;
                    }
                }
                frame = self.guest.next(), if !self.guest_eof && (self.host_write.is_idle() || self.host_write_failed) => {
                    let Some(frame) = frame? else {
                        self.guest_eof = true;
                        continue;
                    };
                    if self.selected.as_ref().is_some_and(|selected| {
                        frame.sequence() == selected.request.sequence()
                            && selected.kind.terminal_type(frame.message_type()) && !selected.completed
                    }) {
                        let selected = self.selected.as_ref().ok_or_else(|| io::Error::other("selected Guest request absent"))?;
                        if !selected.dispatched || self.held_response.is_some() {
                            return Err(io::Error::new(io::ErrorKind::InvalidData,
                                "Guest terminal preceded dispatch or duplicated the selected result"));
                        }
                        if let Some(response) = self.response.take() {
                            let _ = response.send(frame.clone());
                        }
                        self.held_response = Some(frame);
                    } else if !self.host_write_failed {
                        self.host_write.queue(frame, Kind::Forward)?;
                    }
                }
                result = self.guest_write.flush(), if !self.guest_write.is_idle() => {
                    match result {
                        Ok(job) => if matches!(job.kind, Kind::Request) {
                            self.selected.as_mut().ok_or_else(|| io::Error::other("selected Guest request absent"))?.dispatched = true;
                        },
                        Err(error) => {
                            self.guest_write.take();
                            self.guest_write_failed = true;
                            self.record_error(error);
                        }
                    }
                }
                result = self.host_write.flush(), if !self.host_write.is_idle() => {
                    match result {
                        Ok(job) => if let Kind::Terminal(disposition) = job.kind {
                            if disposition == ResponseDisposition::UnwindAfterDelivery {
                                std::panic::resume_unwind(Box::new("Guest response relay unwound after original delivery"));
                            }
                            self.complete_exchange(job.frame, Ok(()))?;
                        },
                        Err(error) => {
                            if let Some(job) = self.host_write.take()
                                && matches!(job.kind, Kind::Terminal(_))
                            {
                                self.complete_exchange(job.frame, Err(copy_error(&error)))?;
                            }
                            self.host_write_failed = true;
                            // Continue draining real Guest work despite a lost Host.
                            self.record_error(error);
                        }
                    }
                }
                _ = receive(&mut self.dispatch), if self.held_request.is_some() && self.guest_write.is_idle() && !self.guest_write_failed => {
                    self.dispatch = None;
                    let frame = self.held_request.take().ok_or_else(|| io::Error::other("held Guest request absent"))?;
                    self.guest_write.queue(frame, Kind::Request)?;
                }
                disposition = receive(&mut self.delivery), if self.held_response.is_some() && self.host_write.is_idle() => {
                    self.delivery = None;
                    let frame = self.held_response.take().ok_or_else(|| io::Error::other("held Guest terminal absent"))?;
                    if self.host_write_failed {
                        let error = self.error.as_ref().ok_or_else(|| io::Error::other("Guest relay lost delivery failure"))?;
                        self.complete_exchange(frame, Err(copy_error(error)))?;
                    } else {
                        self.host_write.queue(frame, Kind::Terminal(disposition.unwrap_or(ResponseDisposition::Deliver)))?;
                    }
                }
            }
        }
    }
}

fn copy_error(error: &io::Error) -> io::Error {
    io::Error::new(error.kind(), error.to_string())
}

async fn receive<T>(receiver: &mut Option<oneshot::Receiver<T>>) -> Option<T> {
    match receiver {
        Some(receiver) => receiver.await.ok(),
        None => pending().await,
    }
}

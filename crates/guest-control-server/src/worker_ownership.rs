use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use crate::log::log;
use crate::writer::GuestWriter;

pub(crate) enum LazyConnectionWorkerSubmitError {
    Busy,
    Disconnected,
    Start(io::Error),
}

struct LazyConnectionWorkerState<Request> {
    sender: SyncSender<Request>,
    handle: JoinHandle<()>,
}

type LazyConnectionWorkerHandler<Request, Context> =
    fn(Request, &GuestWriter, &AtomicBool, &Context) -> io::Result<()>;

pub(crate) struct LazyConnectionWorker<Request, Context>
where
    Request: Send + 'static,
    Context: Clone + Send + 'static,
{
    state: Mutex<Option<LazyConnectionWorkerState<Request>>>,
    writer: GuestWriter,
    context: Context,
    handler: LazyConnectionWorkerHandler<Request, Context>,
    thread_name: &'static str,
    worker_label: &'static str,
    admission: SingleActiveAdmission,
    connection_cancel: Arc<AtomicBool>,
}

impl<Request, Context> LazyConnectionWorker<Request, Context>
where
    Request: Send + 'static,
    Context: Clone + Send + 'static,
{
    pub(crate) fn new(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        context: Context,
        handler: LazyConnectionWorkerHandler<Request, Context>,
        thread_name: &'static str,
        worker_label: &'static str,
    ) -> Self {
        Self {
            state: Mutex::new(None),
            writer,
            context,
            handler,
            thread_name,
            worker_label,
            admission: SingleActiveAdmission::new(),
            connection_cancel,
        }
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.admission.try_acquire()
    }

    pub(crate) fn try_submit_with(
        &self,
        build_request: impl FnOnce() -> Request,
    ) -> Result<(), LazyConnectionWorkerSubmitError> {
        let sender = self.sender()?;
        match sender.try_send(build_request()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(LazyConnectionWorkerSubmitError::Busy),
            Err(TrySendError::Disconnected(_)) => {
                Err(LazyConnectionWorkerSubmitError::Disconnected)
            }
        }
    }

    fn sender(&self) -> Result<SyncSender<Request>, LazyConnectionWorkerSubmitError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(state) = &*state {
            return Ok(state.sender.clone());
        }

        // Admission bounds active plus queued work to one. The channel keeps
        // submission nonblocking even before the worker reaches `recv`.
        let (sender, receiver) = mpsc::sync_channel(1);
        let writer = self.writer.clone();
        let worker_cancel = Arc::clone(&self.connection_cancel);
        let context = self.context.clone();
        let handler = self.handler;
        let worker_label = self.worker_label;
        let handle = thread::Builder::new()
            .name(self.thread_name.to_string())
            .spawn(move || {
                // Each lazy worker belongs to one connection. Any thread exit
                // closes it so no host request can lose its response producer.
                let _shutdown_on_exit = ShutdownConnectionOnDrop::new(writer.clone());
                while let Ok(request) = receiver.recv() {
                    if let Err(error) = handler(request, &writer, &worker_cancel, &context) {
                        log("ERROR", &format!("{worker_label} failed: {error}"));
                        break;
                    }
                }
            })
            .map_err(LazyConnectionWorkerSubmitError::Start)?;
        *state = Some(LazyConnectionWorkerState {
            sender: sender.clone(),
            handle,
        });
        Ok(sender)
    }
}

impl<Request, Context> Drop for LazyConnectionWorker<Request, Context>
where
    Request: Send + 'static,
    Context: Clone + Send + 'static,
{
    fn drop(&mut self) {
        // Signal first so active domain work can stop before sender closure and
        // the connection-owned thread join.
        self.connection_cancel.store(true, Ordering::Release);
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(state) = state.take() {
            drop(state.sender);
            if state.handle.join().is_err() {
                log("ERROR", &format!("{} panicked", self.worker_label));
            }
        }
    }
}

pub(crate) struct SingleActiveAdmission {
    active: Arc<AtomicBool>,
}

impl SingleActiveAdmission {
    pub(crate) fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn try_acquire(&self) -> Option<SingleActivePermit> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| SingleActivePermit {
                active: Arc::clone(&self.active),
            })
    }
}

pub(crate) struct SingleActivePermit {
    active: Arc<AtomicBool>,
}

impl Drop for SingleActivePermit {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

pub(crate) struct ShutdownConnectionOnDrop(GuestWriter);

impl ShutdownConnectionOnDrop {
    pub(crate) fn new(writer: GuestWriter) -> Self {
        Self(writer)
    }
}

impl Drop for ShutdownConnectionOnDrop {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

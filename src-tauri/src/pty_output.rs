//! Batched, flow-controlled terminal output shared by every PTY backend.
//!
//! Output is sent to the webview as raw bytes over a `tauri::ipc::Channel`. Each message
//! is one tag byte followed by the payload:
//!
//! - `FRAME_DATA`: terminal bytes, written to xterm.js as-is (xterm decodes UTF-8 itself)
//! - `FRAME_CLOSED`: UTF-8 message describing why the session ended; always the last frame
//!
//! Every channel message costs a webview `eval` (and a fetch round-trip above 1 KiB), so
//! bytes are batched to at most one message per `FRAME_INTERVAL` while output is
//! streaming. A lone chunk after an idle period, such as a keystroke echo, is sent
//! immediately. The frontend acknowledges bytes once xterm.js has parsed them; while
//! more than `MAX_UNACKED_BYTES` are outstanding, backends stop reading so the remote
//! side is throttled instead of memory piling up in the webview.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

const FRAME_DATA: u8 = 0;
const FRAME_CLOSED: u8 = 1;

pub const FRAME_INTERVAL: Duration = Duration::from_millis(8);
const MAX_BATCH_BYTES: usize = 256 * 1024;
const MAX_UNACKED_BYTES: usize = 4 * 1024 * 1024;

pub type OutputChannel = Channel<InvokeResponseBody>;

/// Bytes sent to the webview but not yet parsed by xterm.js.
#[derive(Clone, Default)]
pub struct Unacked(Arc<AtomicUsize>);

impl Unacked {
    pub fn ack(&self, bytes: usize) {
        let _ = self
            .0
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                Some(current.saturating_sub(bytes))
            });
    }

    /// Whether backends should stop reading until more output is acknowledged.
    pub fn saturated(&self) -> bool {
        self.get() >= MAX_UNACKED_BYTES
    }

    fn get(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }

    fn add(&self, bytes: usize) {
        self.0.fetch_add(bytes, Ordering::Relaxed);
    }
}

pub struct OutputPump {
    channel: OutputChannel,
    unacked: Unacked,
    buffer: Vec<u8>,
    last_flush: Instant,
}

impl OutputPump {
    pub fn new(channel: OutputChannel, unacked: Unacked) -> Self {
        let mut buffer = Vec::with_capacity(64 * 1024);
        buffer.push(FRAME_DATA);
        Self {
            channel,
            unacked,
            buffer,
            last_flush: Instant::now() - FRAME_INTERVAL,
        }
    }

    /// Whether the backend should read more output right now.
    pub fn wants_input(&self) -> bool {
        self.pending() < MAX_BATCH_BYTES && !self.unacked.saturated()
    }

    pub fn push(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
    }

    /// Sends buffered bytes if a frame is due. Returns how long to wait before the
    /// next flush is due when bytes are still buffered.
    pub fn flush_if_due(&mut self) -> Option<Duration> {
        if self.pending() == 0 {
            return None;
        }
        let elapsed = self.last_flush.elapsed();
        if self.pending() >= MAX_BATCH_BYTES || elapsed >= FRAME_INTERVAL {
            self.flush();
            None
        } else {
            Some(FRAME_INTERVAL - elapsed)
        }
    }

    /// Flushes remaining output, then sends the closing message.
    pub fn close(mut self, message: &str) {
        self.flush();
        let mut frame = Vec::with_capacity(message.len() + 1);
        frame.push(FRAME_CLOSED);
        frame.extend_from_slice(message.as_bytes());
        let _ = self.channel.send(InvokeResponseBody::Raw(frame));
    }

    fn pending(&self) -> usize {
        self.buffer.len() - 1
    }

    fn flush(&mut self) {
        let pending = self.pending();
        if pending == 0 {
            return;
        }
        let mut frame = Vec::with_capacity(64 * 1024);
        frame.push(FRAME_DATA);
        let frame = std::mem::replace(&mut self.buffer, frame);
        self.unacked.add(pending);
        self.last_flush = Instant::now();
        // A send only fails once the webview is gone; the session is closed separately.
        let _ = self.channel.send(InvokeResponseBody::Raw(frame));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn capture() -> (OutputChannel, Arc<Mutex<Vec<Vec<u8>>>>) {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sink = frames.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().push(bytes);
            }
            Ok(())
        });
        (channel, frames)
    }

    #[test]
    fn first_chunk_after_idle_is_sent_immediately() {
        let (channel, frames) = capture();
        let mut pump = OutputPump::new(channel, Unacked::default());
        pump.push(b"a");
        assert_eq!(pump.flush_if_due(), None);
        assert_eq!(*frames.lock().unwrap(), vec![vec![FRAME_DATA, b'a']]);
    }

    #[test]
    fn output_within_a_frame_is_batched() {
        let (channel, frames) = capture();
        let mut pump = OutputPump::new(channel, Unacked::default());
        pump.push(b"a");
        pump.flush_if_due();
        pump.push(b"b");
        pump.push(b"c");
        let wait = pump
            .flush_if_due()
            .expect("second chunk waits for the next frame");
        assert!(wait <= FRAME_INTERVAL);
        assert_eq!(frames.lock().unwrap().len(), 1);
        std::thread::sleep(wait);
        assert_eq!(pump.flush_if_due(), None);
        assert_eq!(frames.lock().unwrap()[1], vec![FRAME_DATA, b'b', b'c']);
    }

    #[test]
    fn full_batch_is_sent_without_waiting() {
        let (channel, frames) = capture();
        let mut pump = OutputPump::new(channel, Unacked::default());
        pump.push(b"a");
        pump.flush_if_due();
        pump.push(&vec![b'x'; MAX_BATCH_BYTES]);
        assert!(!pump.wants_input());
        assert_eq!(pump.flush_if_due(), None);
        assert_eq!(frames.lock().unwrap()[1].len(), MAX_BATCH_BYTES + 1);
    }

    #[test]
    fn unacked_output_pauses_reading_until_acknowledged() {
        let (channel, _frames) = capture();
        let unacked = Unacked::default();
        let mut pump = OutputPump::new(channel, unacked.clone());
        for _ in 0..MAX_UNACKED_BYTES / MAX_BATCH_BYTES {
            pump.push(&vec![0; MAX_BATCH_BYTES]);
            pump.flush_if_due();
        }
        assert!(!pump.wants_input());
        unacked.ack(MAX_BATCH_BYTES);
        assert!(pump.wants_input());
        unacked.ack(usize::MAX);
        assert_eq!(unacked.get(), 0);
    }

    #[test]
    fn close_flushes_pending_output_before_the_close_frame() {
        let (channel, frames) = capture();
        let mut pump = OutputPump::new(channel, Unacked::default());
        pump.push(b"a");
        pump.flush_if_due();
        pump.push(b"tail");
        pump.close("Remote shell exited");
        let frames = frames.lock().unwrap();
        assert_eq!(frames[1], [&[FRAME_DATA][..], b"tail"].concat());
        assert_eq!(
            frames[2],
            [&[FRAME_CLOSED][..], b"Remote shell exited"].concat()
        );
    }
}

//! The bounded queue in front of the mempool's own verifier workers.
//!
//! RPC and P2P admission share one queue. Each worker thread owns one
//! persistent verifier and runs whole admissions taken from the queue, so a
//! waiting submitter holds no runtime thread and derivation's separate verifier
//! is never involved. A full queue refuses at once. Peers may hold only half of
//! it, so gossip cannot lock local RPC clients out.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

use crossbeam_channel::Sender;
use pcash_verify::BbProcessVerifier;

pub(super) type Job = Box<dyn FnOnce(&BbProcessVerifier) + Send>;

pub struct AdmissionPool {
    jobs: Sender<Job>,
    peer_jobs: Arc<AtomicUsize>,
    peer_limit: usize,
}

/// One peer admission's claim on the peers' share, released when dropped.
pub(super) struct PeerSlot(Arc<AtomicUsize>);

impl Drop for PeerSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl AdmissionPool {
    /// Start one worker per verifier behind room for `queue` waiting admissions.
    pub fn new(verifiers: Vec<BbProcessVerifier>, queue: usize) -> std::io::Result<Self> {
        let (jobs, receiver) = crossbeam_channel::bounded::<Job>(queue);
        for (index, verifier) in verifiers.into_iter().enumerate() {
            let receiver = receiver.clone();
            // Workers are never joined: the last handle on the mempool may drop
            // on a worker. Once every sender is gone they drain the queue and
            // exit, and dropping each verifier reaps its `bb` child.
            thread::Builder::new()
                .name(format!("pcash-mempool-verifier-{index}"))
                .spawn(move || {
                    for job in receiver {
                        // A panicking admission must not shrink the pool.
                        let _ = catch_unwind(AssertUnwindSafe(|| job(&verifier)));
                    }
                })?;
        }
        Ok(Self {
            jobs,
            peer_jobs: Arc::new(AtomicUsize::new(0)),
            peer_limit: (queue / 2).max(1),
        })
    }

    /// Claim room for one peer admission, queued or running.
    pub(super) fn reserve_peer(&self) -> Option<PeerSlot> {
        self.peer_jobs
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |held| {
                (held < self.peer_limit).then_some(held + 1)
            })
            .ok()
            .map(|_| PeerSlot(Arc::clone(&self.peer_jobs)))
    }

    /// Queue `job` for the next free worker; `false` means the queue is full
    /// and `job` was dropped unrun.
    pub(super) fn try_submit(&self, job: Job) -> bool {
        self.jobs.try_send(job).is_ok()
    }

    /// Admissions waiting for a worker.
    pub(super) fn queued(&self) -> usize {
        self.jobs.len()
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;

    use std::sync::{mpsc, Condvar, Mutex};
    use std::time::Duration;

    const PATIENCE: Duration = Duration::from_secs(5);

    fn pool(workers: usize, queue: usize) -> AdmissionPool {
        let verifiers = (0..workers)
            .map(|_| BbProcessVerifier::new("unused-bb"))
            .collect();
        AdmissionPool::new(verifiers, queue).unwrap()
    }

    #[test]
    fn every_worker_runs_a_job_at_once() {
        let pool = pool(3, 3);
        let arrived = Arc::new((Mutex::new(0usize), Condvar::new()));
        let (done, results) = mpsc::channel();
        for _ in 0..3 {
            let arrived = Arc::clone(&arrived);
            let done = done.clone();
            assert!(pool.try_submit(Box::new(move |_| {
                let (count, all_here) = &*arrived;
                let mut count = count.lock().unwrap();
                *count += 1;
                all_here.notify_all();
                let (count, timeout) = all_here
                    .wait_timeout_while(count, PATIENCE, |count| *count < 3)
                    .unwrap();
                done.send(!timeout.timed_out() && *count == 3).unwrap();
            })));
        }
        for _ in 0..3 {
            assert!(results.recv_timeout(PATIENCE * 2).unwrap());
        }
    }

    #[test]
    fn full_queue_refuses_immediately() {
        let pool = pool(1, 1);
        let (started, running) = mpsc::channel();
        let (release, gate) = mpsc::channel::<()>();
        assert!(pool.try_submit(Box::new(move |_| {
            started.send(()).unwrap();
            gate.recv().unwrap();
        })));
        running.recv_timeout(PATIENCE).unwrap();

        let (ran, second) = mpsc::channel();
        assert!(pool.try_submit(Box::new(move |_| ran.send(()).unwrap())));
        assert_eq!(pool.queued(), 1);
        assert!(!pool.try_submit(Box::new(|_| panic!("refused job must not run"))));

        release.send(()).unwrap();
        second.recv_timeout(PATIENCE).unwrap();
    }

    #[test]
    fn peers_hold_at_most_half_the_queue() {
        let shared = pool(1, 4);
        let first = shared.reserve_peer().unwrap();
        let _second = shared.reserve_peer().unwrap();
        assert!(shared.reserve_peer().is_none());
        drop(first);
        assert!(shared.reserve_peer().is_some());

        let tiny = pool(1, 1);
        let _only = tiny.reserve_peer().unwrap();
        assert!(tiny.reserve_peer().is_none());
    }

    #[test]
    fn worker_survives_a_panicking_job() {
        let pool = pool(1, 2);
        assert!(pool.try_submit(Box::new(|_| panic!("admission bug"))));
        let (ran, after) = mpsc::channel();
        assert!(pool.try_submit(Box::new(move |_| ran.send(()).unwrap())));
        after.recv_timeout(PATIENCE).unwrap();
    }
}

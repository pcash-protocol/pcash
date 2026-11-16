#![cfg(unix)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for process setup"
)]

use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct StopOnDrop(Child);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn termination_signals_stop_bootstrap_while_l1_is_unresponsive() {
    for signal in ["-TERM", "-INT"] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let directory = tempfile::tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_pcash-node"));
        for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("PCASH_")) {
            command.env_remove(key);
        }
        let mut child = StopOnDrop(
            command
                .args([
                    "--dev",
                    "--disable-p2p",
                    "--l1-rpc",
                    &url,
                    "--beacon-api",
                    &url,
                ])
                .arg("--data-dir")
                .arg(directory.path())
                .args([
                    "--genesis-l1-block",
                    "0",
                    "--genesis-l1-block-hash",
                    "0x1111111111111111111111111111111111111111111111111111111111111111",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        let _blocked_request = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("accept: {error}"),
            }
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "node exited before L1 request"
            );
            assert!(Instant::now() < deadline, "node never requested L1");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(Command::new("kill")
            .args([signal, &child.0.id().to_string()])
            .status()
            .unwrap()
            .success());
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "bootstrap ignored {signal}");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success(), "bootstrap shutdown failed: {status}");
    }
}

#!/usr/bin/env python3
"""Real TCP discovery/NAT acceptance test. Run as root on an isolated Linux host.

Build: cargo build --locked -p pcash-p2p --example network_probe
Run: sudo python3 scripts/test-p2p-nat.py --binary target/debug/examples/network_probe

Only namespaces created by this invocation are modified. No external network,
L1 RPC, Docker daemon, or proof toolchain is used by the test itself.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time


class Harness:
    NODE_NUMBERS = {"r1": 1, "r2": 2, "a": 3, "b": 4}

    def __init__(self, binary, output):
        self.binary = binary.resolve()
        self.output = output
        output.mkdir(parents=True, exist_ok=True)
        self.prefix = f"pcash-{os.getpid()}-"
        self.namespaces = []
        self.processes = {}
        self.streams = []
        self.serial = 0
        self.ids = {
            name: subprocess.check_output(
                [str(self.binary), "--peer-id"], text=True,
                env={**os.environ, "P2P_TEST_ID": str(number)},
            ).strip()
            for name, number in self.NODE_NUMBERS.items()
        }
        self.seed = f"/ip4/198.18.0.2/tcp/8646/p2p/{self.ids['r1']}"

    @staticmethod
    def run(*command):
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)

    def ns(self, name, *command):
        self.run("ip", "netns", "exec", self.prefix + name, *command)

    def create(self, name):
        self.run("ip", "netns", "add", self.prefix + name)
        self.namespaces.append(self.prefix + name)
        self.ns(name, "ip", "link", "set", "lo", "up")

    def link(self, first, iface, second, other, address):
        self.serial += 1
        left, right = f"p{os.getpid()}a{self.serial}", f"p{os.getpid()}b{self.serial}"
        self.run("ip", "link", "add", left, "type", "veth", "peer", "name", right)
        self.run("ip", "link", "set", left, "netns", self.prefix + first)
        self.run("ip", "link", "set", right, "netns", self.prefix + second)
        self.ns(first, "ip", "link", "set", left, "name", iface)
        self.ns(second, "ip", "link", "set", right, "name", other)
        self.ns(first, "ip", "link", "set", iface, "up")
        self.ns(second, "ip", "link", "set", other, "up")
        self.ns(second, "ip", "addr", "add", address, "dev", other)

    def start(self, name, phase, burst=False):
        number = self.NODE_NUMBERS[name]
        env = {
            **os.environ, "P2P_TEST_ID": str(number),
            "P2P_TEST_BOOTNODES": "" if name == "r1" else self.seed,
            "P2P_TEST_BURST": str(burst).lower(),
        }
        if name.startswith("r"):
            env.update(
                P2P_TEST_ADVERTISE=f"/ip4/198.18.0.{number+1}/tcp/8646",
                P2P_TEST_RELAY_SERVER="true",
            )
        out = (self.output / f"{phase}-{name}.jsonl").open("w")
        err = (self.output / f"{phase}-{name}.stderr").open("w")
        self.streams.extend([out, err])
        process = subprocess.Popen(
            ["ip", "netns", "exec", self.prefix + name, str(self.binary)],
            env=env, stdin=subprocess.PIPE, stdout=out, stderr=err, text=True,
        )
        self.processes[name] = (process, Path(out.name))

    def stop(self, name):
        process, _ = self.processes.pop(name)
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdin.close()

    def snapshot(self, name):
        process, path = self.processes[name]
        if process.poll() is not None:
            raise AssertionError(f"{name} exited with {process.returncode}; see {path.with_suffix('.stderr')}")
        for line in reversed(path.read_text().splitlines()):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass
        return {}

    def network(self, name):
        return self.snapshot(name).get("network", {})

    def received(self, by, sender):
        return self.snapshot(by).get("received", {}).get(self.ids[sender], 0)

    def fetched(self, by, sender):
        # Sync origin names the serving connection, unlike gossip's publisher.
        return self.snapshot(by).get("fetched", {}).get(self.ids[sender])

    def wait(self, description, predicate, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                print(f"PASS: {description}", flush=True)
                return
            time.sleep(0.2)
        state = {name: self.snapshot(name) for name in self.processes}
        raise AssertionError(f"{description}: timed out; last state={json.dumps(state)}")

    def command(self, name, operation, **arguments):
        command_id = str(time.monotonic_ns())
        process, _ = self.processes[name]
        process.stdin.write(json.dumps({"id": command_id, "operation": operation, **arguments}) + "\n")
        process.stdin.flush()
        self.wait(f"{name} applies {operation}",
                  lambda: self.snapshot(name).get("lastCommand") == command_id, timeout=15)

    def connection(self, source, target, relayed, count=None):
        return any(
            peer["id"] == self.ids[target] and peer["compatible"]
            and ("/p2p-circuit" in peer["address"]) == relayed
            and (count is None or peer["connections"] == count)
            for peer in self.snapshot(source).get("peers", [])
        )

    def circuit_events(self, message):
        # Logs identify both ends; quota exhaustion on another pair cannot pass.
        events = []
        for relay in ("r1", "r2"):
            path = self.output / f"fallback-{relay}.stderr"
            for line in path.read_text().splitlines():
                if message in line and all(self.ids[node] in line for node in ("a", "b")):
                    events.append(line)
        return sorted(events)  # tracing's UTC timestamps order the two relays.

    def quota_disconnect(self):
        active = 0
        for line in self.circuit_events("relay circuit"):
            if "relay circuit accepted" in line:
                active += 1
            elif "relay circuit closed" in line:
                active -= 1
                if active == 0 and "Max circuit bytes reached." in line:
                    return line.split()[0]
        return None

    def quota_recovery(self):
        # Two connections per peer are allowed during upgrades. Exhaust both
        # existing circuits so a surviving old circuit cannot satisfy recovery.
        self.wait("quota closes the last existing A-B circuit",
                  self.quota_disconnect, timeout=240)
        closed_at = self.quota_disconnect()
        self.command("b", "stopPublishing")
        self.wait("fresh A-B circuit accepted after quota closure", lambda: any(
            line.split()[0] > closed_at for line in self.circuit_events("relay circuit accepted")
        ))
        self.wait("recovered A-B circuit completes compatibility handshake",
                  lambda: self.connection("a", "b", True) and self.connection("b", "a", True))
        # Sample only after closure and fresh establishment. This token did not
        # exist before recovery and is never announced on gossip by the fixture.
        baseline = self.fetched("a", "b")
        token = f"post-quota-{time.monotonic_ns()}"
        assert baseline != token
        self.command("b", "inventory", token=token)
        self.wait("new targeted A-B inventory exchange over recovered circuit",
                  lambda: self.connection("a", "b", True) and self.fetched("a", "b") == token)

        # Negative control: third-party gossip connectivity stays up, while both
        # ends refuse A-B reconnection. A new targeted token must not arrive.
        address = self.network("b")["externalAddresses"][0]
        self.command("a", "remove", peer=self.ids["b"])
        self.command("b", "remove", peer=self.ids["a"])
        self.wait("negative control closes A-B", lambda: not any(
            peer["id"] == self.ids["b"] for peer in self.snapshot("a").get("peers", [])
        ))
        blocked_token = f"blocked-{time.monotonic_ns()}"
        self.command("b", "inventory", token=blocked_token)
        deadline = time.monotonic() + 15  # three inventory intervals
        while time.monotonic() < deadline:
            assert self.fetched("a", "b") != blocked_token, "recovery assertion bypassed the A-B path"
            time.sleep(0.2)
        print("PASS: disabled A-B reconnection prevents targeted recovery", flush=True)
        self.command("a", "add", address=address)
        self.wait("restoring A-B allows the withheld targeted exchange",
                  lambda: self.fetched("a", "b") == blocked_token)

    def setup_topology(self):
        for name in ["pub", "r1", "r2", "g1", "g2", "a", "b"]:
            self.create(name)
        self.ns("pub", "ip", "link", "add", "br0", "type", "bridge")
        self.ns("pub", "ip", "link", "set", "br0", "up")
        for name, octet in [("r1", 2), ("r2", 3), ("g1", 11), ("g2", 12)]:
            self.link("pub", name, name, "eth0", f"198.18.0.{octet}/24")
            self.ns("pub", "ip", "link", "set", name, "master", "br0")
        for number, client in [(1, "a"), (2, "b")]:
            gateway = f"g{number}"
            self.link(gateway, "eth1", client, "eth0", f"10.{number}.0.2/24")
            self.ns(gateway, "ip", "addr", "add", f"10.{number}.0.1/24", "dev", "eth1")
            self.ns(client, "ip", "route", "add", "default", "via", f"10.{number}.0.1")
            self.ns(gateway, "sysctl", "-q", "-w", "net.ipv4.ip_forward=1")
            self.ns(gateway, "iptables", "-t", "nat", "-A", "POSTROUTING", "-o", "eth0",
                    "-j", "SNAT", "--to-source", f"198.18.0.{10+number}")
            self.ns(gateway, "iptables", "-P", "FORWARD", "DROP")
            # Unmapped SYNs time out so simultaneous-open mappings can form.
            self.ns(gateway, "iptables", "-P", "INPUT", "DROP")
            self.ns(gateway, "iptables", "-A", "FORWARD", "-i", "eth1", "-j", "ACCEPT")
            self.ns(gateway, "iptables", "-A", "FORWARD", "-m", "conntrack",
                    "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")

    def cleanup(self):
        for name in list(self.processes):
            self.stop(name)
        for stream in self.streams:
            stream.close()
        for name in reversed(self.namespaces):
            subprocess.run(["ip", "netns", "del", name], check=False)


def scenarios(harness):
    harness.setup_topology()
    for name in ["r1", "r2", "b", "a"]:
        harness.start(name, "direct")
    harness.wait("TCP hole punch through two independent NAT gateways",
           lambda: harness.connection("a", "b", False))
    harness.wait("direct upgrade closes only redundant relay connections", lambda: all(
        harness.connection(source, target, False, count=1) for source, target in [("a", "b"), ("b", "a")]
    ))
    harness.wait("direct upgrade retains peer state and exchanges payloads", lambda: harness.received("a", "b") > 0)
    harness.wait("DCUtR reports the successful direct upgrade", lambda:
           sum(harness.network(node).get("holePunchesSucceeded", 0) for node in ("a", "b")) > 0)
    for name in list(harness.processes):
        harness.stop(name)

    # Block only gateway-to-gateway traffic, preserving outbound relay access.
    for number, destination in [(1, "198.18.0.12"), (2, "198.18.0.11")]:
        harness.ns(f"g{number}", "iptables", "-I", "FORWARD", "1", "-d", destination, "-j", "DROP")
    for name in ["r1", "r2", "b", "a"]:
        harness.start(name, "fallback", burst=name == "b")
    harness.wait("NAT peers discover each other using relay endpoints", lambda: harness.connection("a", "b", True))
    harness.wait("two independent relay reservations", lambda: all(
        len(harness.network(node).get("relayReservations", [])) == 2 for node in ("a", "b")
    ))
    harness.wait("failed punching preserves relay fallback", lambda:
           harness.connection("a", "b", True)
           and sum(harness.network(node).get("holePunchesFailed", 0) for node in ("a", "b")) > 0)
    harness.quota_recovery()
    harness.stop("r1")
    harness.wait("failed relay address is withdrawn", lambda: all(
        harness.ids["r1"] not in str(harness.network(node).get("externalAddresses", [])) for node in ("a", "b")
    ))
    token = f"surviving-relay-{time.monotonic_ns()}"
    harness.command("b", "inventory", token=token)
    harness.wait("surviving relay carries targeted peer traffic", lambda:
           harness.connection("a", "b", True) and harness.fetched("a", "b") == token)
    print("All discovery/NAT acceptance scenarios passed.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(".cache/p2p-nat"))
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        parser.error("requires Linux and root (network namespaces and nftables/iptables)")
    harness = Harness(args.binary, args.output)
    try:
        scenarios(harness)
    finally:
        harness.cleanup()


if __name__ == "__main__":
    main()

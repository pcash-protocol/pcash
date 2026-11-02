import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptSecret } from "../../src/wallet/node/terminal.ts";

vi.mock("node:readline", () => ({ createInterface: vi.fn() }));

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, descriptor] of [[process.stdin, stdinTty], [process.stderr, stderrTty]] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
    else Object.defineProperty(stream, "isTTY", descriptor);
  }
});

describe("secret terminal input", () => {
  it("disables echo and installs input handlers before a prompt can receive an immediate response", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    const question = "Recovery phrase: ";
    const secret = "dummy secret";
    let echoEnabled = true;
    let answer: ((value: string) => void) | undefined;
    const readline = Object.assign(new EventEmitter(), {
      question: vi.fn((_prompt: string, callback: (value: string) => void) => { answer = callback; }),
      close: vi.fn(() => { readline.emit("close"); }),
    });
    vi.mocked(createInterface).mockImplementation(() => {
      echoEnabled = false;
      return readline as unknown as Interface;
    });
    const output = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      if (chunk === question) {
        expect(echoEnabled).toBe(false);
        expect(readline.listenerCount("SIGINT")).toBe(1);
        expect(readline.listenerCount("close")).toBe(1);
        expect(answer).toBeTypeOf("function");
        answer!(secret);
      }
      return true;
    });

    await expect(promptSecret(question)).resolves.toBe(secret);
    expect(createInterface).toHaveBeenCalledWith(expect.objectContaining({ terminal: true, historySize: 0 }));
    expect(output.mock.calls.map(([chunk]) => chunk)).toEqual([question, "\n"]);
    expect(readline.close).toHaveBeenCalledTimes(1);
  });
});

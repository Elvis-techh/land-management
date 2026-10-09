import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StreamSource, StreamTimers } from "../src/lib/liveUpdates";
import { openLiveStream } from "../src/lib/liveUpdates";

/*
 * The browser's own `EventSource` retries a dropped connection, but gives up
 * for good on an answer that is not the stream — the 502 Nginx sends while a
 * deploy's new process is still starting. Before this, a tab that reconnected
 * a moment too early stopped hearing about other people's writes until it was
 * reloaded, and nothing on the screen said so.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** An `EventSource` the test drives by hand. */
class FakeSource implements StreamSource {
  readyState = CONNECTING;
  closed = false;
  private listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }

  emit(type: "open" | "change" | "error"): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  open(): void {
    this.readyState = OPEN;
    this.emit("open");
  }

  /** The connection dropped; the browser is retrying by itself. */
  drop(): void {
    this.readyState = CONNECTING;
    this.emit("error");
  }

  /** A 502, a 503: the browser has given up on this one. */
  refuse(): void {
    this.readyState = CLOSED;
    this.emit("error");
  }
}

/** Timers that only fire when the test says so. */
class FakeTimers implements StreamTimers {
  private next = 1;
  pending = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  }

  clearTimeout(id: number | undefined): void {
    if (id !== undefined) {
      this.pending.delete(id);
    }
  }

  /** The waits currently scheduled, in milliseconds. */
  waits(): number[] {
    return [...this.pending.values()].map(({ ms }) => ms);
  }

  runAll(): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    due.forEach(({ callback }) => callback());
  }
}

function setUp() {
  const sources: FakeSource[] = [];
  const timers = new FakeTimers();
  const calls = { change: 0, reconnected: 0 };

  const stream = openLiveStream(
    () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    { change: () => calls.change++, reconnected: () => calls.reconnected++ },
    timers,
  );

  return { stream, sources, timers, calls, latest: () => sources[sources.length - 1] };
}

describe("openLiveStream", () => {
  it("passes changes through, and does not count the first open as a reconnection", () => {
    const { latest, calls } = setUp();

    latest().open();
    latest().emit("change");

    assert.deepEqual(calls, { change: 1, reconnected: 0 });
  });

  it("reopens a stream the browser gave up on, and reloads once it is back", () => {
    const { sources, timers, calls, latest } = setUp();

    latest().open();
    latest().refuse();

    assert.equal(sources.length, 1, "waits before reopening");
    assert.deepEqual(timers.waits(), [3_000]);

    timers.runAll();
    assert.equal(sources.length, 2);

    latest().open();
    assert.equal(calls.reconnected, 1, "writes made while it was down were never announced");

    latest().emit("change");
    assert.equal(calls.change, 1, "the new stream is listened to");
  });

  it("leaves an ordinary dropped connection to the browser's own retry", () => {
    const { sources, timers, calls, latest } = setUp();

    latest().open();
    latest().drop();

    assert.equal(sources.length, 1);
    assert.deepEqual(timers.waits(), []);

    // The browser's retry lands on the same object, and that is a reconnection too.
    latest().open();
    assert.equal(calls.reconnected, 1);
  });

  it("waits longer after each refusal in a row, up to a minute, and starts over once open", () => {
    const { timers, latest } = setUp();
    const waits: number[] = [];

    for (let attempt = 0; attempt < 7; attempt++) {
      latest().refuse();
      waits.push(...timers.waits());
      timers.runAll();
    }

    assert.deepEqual(waits, [3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000]);

    latest().open();
    latest().refuse();
    assert.deepEqual(timers.waits(), [3_000]);
  });

  it("stops for good when closed, even with a reopen pending", () => {
    const { stream, sources, timers, latest } = setUp();

    latest().refuse();
    stream.close();

    assert.deepEqual(timers.waits(), [], "the pending reopen is cancelled");
    assert.equal(sources.length, 1);
  });

  it("closes the stream it has open", () => {
    const { stream, latest } = setUp();

    latest().open();
    stream.close();

    assert.equal(latest().closed, true);
  });
});

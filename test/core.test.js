import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttle } from '../src/index.js';

// --- Fake clock + timer helpers -------------------------------------------

function makeFakeClock() {
  let t = 0;
  const queue = []; // { time, fn }
  let nextId = 1;
  const timersById = new Map();

  const clock = {
    now() { return t; },
    setTimeout(cb, delay) {
      const id = nextId++;
      queue.push({ time: t + delay, fn: cb, id });
      timersById.set(id, true);
      return id;
    },
    clearTimeout(id) {
      timersById.delete(id);
      // Leave it in the queue; runPending skips entries not in timersById.
    },
    // Advance to exactly `ms` and fire any timer due at or before that time.
    // Timers that fire may schedule further timers; those are picked up in
    // subsequent runPending calls within the same advance.
    advance(ms) {
      const target = t + ms;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Find the earliest pending timer that is still registered.
        let earliest = null;
        for (const entry of queue) {
          if (!timersById.has(entry.id)) continue;
          if (entry.time > target) continue;
          if (earliest === null || entry.time < earliest.time) {
            earliest = entry;
          }
        }
        if (earliest === null) break;
        // Remove and fire.
        const idx = queue.indexOf(earliest);
        queue.splice(idx, 1);
        timersById.delete(earliest.id);
        t = earliest.time;
        earliest.fn();
      }
      t = target;
    },
  };
  return clock;
}

function makeThrottle(fn, interval, clock) {
  return throttle(fn, interval, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
}

// --- Tests ----------------------------------------------------------------

test('leading edge fires immediately when cold', () => {
  const clock = makeFakeClock();
  const calls = [];
  const fn = makeThrottle((x) => { calls.push(x); return x * 2; }, 100, clock);

  const result = fn(5);
  assert.equal(result, 10);
  assert.deepEqual(calls, [5]);
});

test('calls within the interval are suppressed and replayed once on the trailing edge', () => {
  const clock = makeFakeClock();
  const calls = [];
  const fn = makeThrottle((x) => { calls.push(x); }, 100, clock);

  fn(1);            // t=0, leading, fires
  fn(2);            // t=0, suppressed, schedules trailing
  fn(3);            // t=0, suppressed, reschedules trailing (latest args)
  assert.deepEqual(calls, [1]);

  clock.advance(100); // trailing fires at t=100
  assert.deepEqual(calls, [1, 3]);
});

test('trailing call uses the latest arguments', () => {
  const clock = makeFakeClock();
  const seen = [];
  const fn = makeThrottle((...args) => { seen.push(args); }, 50, clock);

  fn('a');
  fn('b');
  fn('c');
  clock.advance(50);
  assert.deepEqual(seen, [['a'], ['c']]);
});

test('no trailing call when only the leading call occurs', () => {
  const clock = makeFakeClock();
  const calls = [];
  const fn = makeThrottle((x) => { calls.push(x); }, 100, clock);

  fn(1);
  clock.advance(200);
  assert.deepEqual(calls, [1]);
});

test('preserves `this` on both leading and trailing calls', () => {
  const clock = makeFakeClock();
  const seen = [];
  const fn = makeThrottle(function (x) { seen.push([this.val, x]); }, 100, clock);

  const obj = { val: 'obj', fn };
  obj.fn(1);   // leading
  obj.fn(2);   // suppressed
  clock.advance(100);
  assert.deepEqual(seen, [['obj', 1], ['obj', 2]]);
});

test('after the interval passes, the next call is a leading edge again', () => {
  const clock = makeFakeClock();
  const calls = [];
  const fn = makeThrottle((x) => { calls.push(x); }, 100, clock);

  fn(1);             // t=0 leading
  fn(2);             // t=0 suppressed
  clock.advance(100); // trailing fires at t=100, lastInvoke=100
  assert.deepEqual(calls, [1, 2]);

  clock.advance(100); // t=200, elapsed since lastInvoke=100 >= interval
  fn(3);             // t=200, leading edge
  assert.deepEqual(calls, [1, 2, 3]);
});

test('cancel drops a pending trailing call', () => {
  const clock = makeFakeClock();
  const calls = [];
  const fn = makeThrottle((x) => { calls.push(x); }, 100, clock);

  fn(1);   // leading
  fn(2);   // suppressed, trailing scheduled
  fn.cancel();
  clock.advance(200);
  assert.deepEqual(calls, [1]);
});

test('cancel resets the throttle to cold', () => {
  const clock = makeFakeClock();
  const calls = [];
  const fn = makeThrottle((x) => { calls.push(x); }, 100, clock);

  fn(1);            // t=0 leading
  clock.advance(50); // t=50, still warm
  fn(2);            // suppressed
  fn.cancel();      // reset to cold
  fn(3);            // leading again, despite only 50ms since last real invoke
  assert.deepEqual(calls, [1, 3]);
});

test('suppressed call returns undefined', () => {
  const clock = makeFakeClock();
  const fn = makeThrottle(() => 42, 100, clock);

  const first = fn();
  const second = fn();
  assert.equal(first, 42);
  assert.equal(second, undefined);
});

test('trailing call scheduled during a trailing invocation is honoured', () => {
  // Awkward case: the trailing call itself triggers another suppressed call.
  // The wrapper must not deadlock or lose the new trailing call.
  const clock = makeFakeClock();
  const calls = [];
  let fn;
  fn = makeThrottle((x) => {
    calls.push(x);
    if (x === 'trailing1') {
      // Simulate a call arriving while fn is executing. At this point
      // lastInvoke was just set to ~100, so this is suppressed and a new
      // trailing call is scheduled.
      fn('trailing2');
    }
  }, 100, clock);

  fn('leading');       // t=0, fires
  fn('trailing1');     // t=0, suppressed, trailing scheduled for t=100
  clock.advance(100);  // trailing1 fires at t=100; during it, trailing2 is
                       // called and suppressed, scheduling a trailing for t=200
  assert.deepEqual(calls, ['leading', 'trailing1']);
  clock.advance(100);  // trailing2 fires at t=200
  assert.deepEqual(calls, ['leading', 'trailing1', 'trailing2']);
});

test('zero interval passes every call through immediately', () => {
  const clock = makeFakeClock();
  const calls = [];
  const fn = makeThrottle((x) => { calls.push(x); }, 0, clock);

  fn(1);
  fn(2);
  fn(3);
  assert.deepEqual(calls, [1, 2, 3]);
});

test('throws on non-function fn', () => {
  assert.throws(() => throttle(null, 100), /fn must be a function/);
});

test('throws on negative interval', () => {
  assert.throws(() => throttle(() => {}, -1), /interval must be a non-negative finite number/);
});

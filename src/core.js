/**
 * Create a throttled wrapper around `fn`.
 *
 * The wrapper guarantees `fn` is invoked at most once per `interval` (in
 * milliseconds). The first call after a quiet period fires immediately.
 * Subsequent calls within the same interval are dropped, but the most recent
 * arguments are remembered and replayed exactly once at the start of the next
 * interval — the "trailing" call.
 *
 * Design decisions (stated plainly so callers know what they are getting):
 *
 * 1. Leading edge fires. If the throttle is cold, the call goes through at
 *    once. This matches the common expectation for UI throttling (scroll,
 *    resize) where the first event should feel responsive.
 *
 * 2. Trailing edge fires only if there was a suppressed call during the
 *    interval. If the wrapped function is called exactly once and then never
 *    again, you get exactly one invocation — no redundant trailing echo.
 *
 * 3. `this` and all arguments are preserved on both leading and trailing
 *    calls. The trailing call uses the arguments from the last suppressed
 *    invocation, which is the "latest" semantic most consumers want.
 *
 * 4. The clock is injectable. `now()` returns the current time in ms. In
 *    production you pass `Date.now`; in tests you pass a fake that you advance
 *    manually. This keeps the test suite deterministic — no wall-clock sleeps.
 *
 * 5. The trailing call is scheduled with `setTimeout(cb, delay)` where
 *    `delay` is computed from the injected clock. We do not try to be clever
 *    about coalescing timers; each suppressed call reschedules the trailing
 *    call, which is simple and correct.
 *
 * 6. `cancel()` clears a pending trailing call and resets the throttle to
 *    cold. It does not abort a call that is already in progress (the wrapped
 *    function is synchronous, so this is a non-issue).
 *
 * 7. The wrapper is not re-entrant-safe beyond what JS gives us for free. If
 *    `fn` calls the wrapper recursively, the recursive call is subject to the
 *    same throttling rules.
 *
 * @param {function} fn - The function to wrap.
 * @param {number} interval - Minimum gap between invocations, in ms.
 * @param {object} [options]
 * @param {function} [options.now=Date.now] - Clock function returning ms.
 * @param {function} [options.setTimeout=setTimeout] - Timer scheduler, mainly
 *   for tests that want to capture scheduled callbacks rather than run them.
 * @param {function} [options.clearTimeout=clearTimeout] - Timer clearer.
 * @returns {function} A throttled wrapper with a `.cancel()` method.
 */
export function throttle(fn, interval, options = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('throttle: fn must be a function');
  }
  if (!Number.isFinite(interval) || interval < 0) {
    throw new RangeError('throttle: interval must be a non-negative finite number');
  }

  const now = options.now ?? Date.now;
  const setTimeout_ = options.setTimeout ?? setTimeout;
  const clearTimeout_ = options.clearTimeout ?? clearTimeout;

  let lastInvoke = -Infinity; // ms timestamp of the last real invocation
  let trailingTimer = null;   // timer id for a pending trailing call
  let trailingArgs = null;    // [thisArg, argsArray] for the pending trailing call

  function invoke(target, args) {
    lastInvoke = now();
    return fn.apply(target, args);
  }

  function scheduleTrailing(target, args) {
    // Replace any previously scheduled trailing call. We only ever want one
    // pending, and it should carry the most recent arguments.
    if (trailingTimer !== null) {
      clearTimeout_(trailingTimer);
    }
    trailingArgs = [target, args];
    const elapsed = now() - lastInvoke;
    const delay = Math.max(0, interval - elapsed);
    trailingTimer = setTimeout_(runTrailing, delay);
  }

  function runTrailing() {
    // Captured into locals so a call arriving during fn's execution sees a
    // clean slate (trailingTimer === null) and can schedule fresh.
    const pending = trailingArgs;
    trailingTimer = null;
    trailingArgs = null;
    if (pending !== null) {
      invoke(pending[0], pending[1]);
    }
  }

  function wrapped(...args) {
    const elapsed = now() - lastInvoke;
    if (elapsed >= interval) {
      // Leading edge. Any pending trailing call is now stale; drop it.
      if (trailingTimer !== null) {
        clearTimeout_(trailingTimer);
        trailingTimer = null;
        trailingArgs = null;
      }
      return invoke(this, args);
    }
    // Within the interval — suppress and schedule a trailing replay.
    scheduleTrailing(this, args);
    return undefined;
  }

  wrapped.cancel = function cancel() {
    if (trailingTimer !== null) {
      clearTimeout_(trailingTimer);
      trailingTimer = null;
      trailingArgs = null;
    }
    // Reset to cold so the next call fires immediately on the leading edge.
    lastInvoke = -Infinity;
  };

  return wrapped;
}

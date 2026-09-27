# throttle-decorator

Wraps a function so it executes at most once per configured interval, dropping intermediate calls and replaying the trailing call with the latest arguments.

## Usage

```js
import { throttle } from 'throttle-decorator';

const onScroll = throttle((event) => {
  console.log('scroll', event.target.scrollTop);
}, 100);

// Call it directly — for example, from a scroll listener you wire up yourself.
onScroll({ target: { scrollTop: 0 } });
// Later, to stop any pending trailing call:
onScroll.cancel();
```

## Why this exists

Throttling is the right tool when you have a high-frequency event stream (scroll, resize, pointermove) and you want bounded call frequency without losing the final state. Debouncing delays everything until the stream goes quiet; throttling gives you a leading call and a trailing call with predictable spacing.

The trade-off here is simplicity over configurability. There is no `{ leading: false }` option, no `maxWait`, no flush. The wrapper always fires on the leading edge when cold and always replays the last suppressed call on the trailing edge. If you need to suppress the leading edge, this is not the right library.

## Edge cases worth knowing

- **Trailing call uses the latest arguments**, not the first. If you call `fn(1)` then `fn(2)` within the same interval, the trailing call receives `2`.
- **A single isolated call produces exactly one invocation.** There is no redundant trailing echo when the stream goes silent after the leading edge.
- **`cancel()` resets the throttle to cold.** The next call after `cancel()` fires immediately on the leading edge regardless of how recently the last real invocation happened.
- **The clock is injectable** via the `options.now` argument, which is how the test suite stays deterministic. In production you leave it at the default `Date.now`.

## API

### `throttle(fn, interval, options?)`

- `fn` — the function to wrap.
- `interval` — minimum gap between invocations, in milliseconds. Must be a non-negative finite number.
- `options.now` — optional clock function returning ms. Defaults to `Date.now`.
- `options.setTimeout` / `options.clearTimeout` — optional timer functions, mainly for testing.

Returns a wrapper function that forwards `this` and all arguments. The wrapper has a `.cancel()` method that drops any pending trailing call and resets the throttle to cold.

Suppressed calls return `undefined`; leading-edge calls return whatever `fn` returns.

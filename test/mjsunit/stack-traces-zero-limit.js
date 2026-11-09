// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax

// With Error.stackTraceLimit == 0 a stack trace is still captured, it just
// has no frames: the "stack" accessor is installed, the stack formats to
// the error header, and Error.prepareStackTrace is called with an empty
// array. This is different from a limit that is not a number, which
// disables capturing.

function deep(n, f) { return n > 0 ? deep(n - 1, f) : f(); }

function assertStackAccessor(object) {
  const descriptor = Object.getOwnPropertyDescriptor(object, 'stack');
  assertEquals('function', typeof descriptor.get);
  assertEquals('function', typeof descriptor.set);
  assertFalse(descriptor.enumerable);
  assertTrue(descriptor.configurable);
}

class SubError extends Error {}

for (const limit of [0, -0, -1, 0.5, NaN, -Infinity]) {
  Error.stackTraceLimit = limit;

  // Errors created by constructors.
  for (const [make, header] of [
         [() => new Error('m'), 'Error: m'],
         [() => new Error(), 'Error'],
         [() => Error('m'), 'Error: m'],
         [() => new TypeError('m'), 'TypeError: m'],
         [() => new SubError('m'), 'Error: m'],
         [() => new AggregateError([], 'm'), 'AggregateError: m'],
         [() => Reflect.construct(Error, ['m'], Object), 'Error: m'],
       ]) {
    const error = deep(5, make);
    assertStackAccessor(error);
    assertEquals(header, error.stack);
    assertEquals(header, error.stack);
  }

  // Errors created by the runtime.
  for (const thrower of [() => null.x, () => undefined_variable,
                         () => new Array(-1), () => { throw new Error('m'); },
                         () => JSON.parse('{')]) {
    let error;
    try { deep(5, thrower); } catch (e) { error = e; }
    assertStackAccessor(error);
    assertFalse(error.stack.includes('\n'), error.stack);
    assertTrue(error.stack.endsWith(error.message), error.stack);
  }

  // Error.captureStackTrace.
  {
    const target = {};
    deep(5, () => Error.captureStackTrace(target));
    assertStackAccessor(target);
    assertEquals(['stack'], Reflect.ownKeys(target));
    assertEquals('Error', target.stack);

    const named = {name: 'Name', message: 'message'};
    deep(5, () => Error.captureStackTrace(named));
    assertEquals('Name: message', named.stack);

    function constructorOpt() {
      const result = {};
      Error.captureStackTrace(result, constructorOpt);
      return result;
    }
    assertEquals('Error', deep(5, constructorOpt).stack);
    const absent = {};
    Error.captureStackTrace(absent, function notOnTheStack() {});
    assertEquals('Error', absent.stack);

    const error = new RangeError('m');
    deep(5, () => Error.captureStackTrace(error));
    assertEquals('RangeError: m', error.stack);

    assertThrows(() => Error.captureStackTrace(Object.freeze({})), TypeError);
    assertThrows(() => Error.captureStackTrace(1), TypeError);
  }

  // The stack can still be set.
  {
    const error = new Error('m');
    error.stack = 'replaced';
    assertEquals('replaced', error.stack);
  }
}

// Error.prepareStackTrace sees an empty array of call sites, once.
(function TestPrepareStackTrace() {
  Error.stackTraceLimit = 0;
  const calls = [];
  Error.prepareStackTrace = (error, frames) => {
    calls.push([error, frames]);
    return 'prepared ' + frames.length;
  };
  try {
    const error = deep(5, () => new Error('m'));
    assertEquals([], calls);
    assertEquals('prepared 0', error.stack);
    assertEquals('prepared 0', error.stack);
    assertEquals(1, calls.length);
    assertSame(error, calls[0][0]);
    assertTrue(Array.isArray(calls[0][1]));
    assertEquals(0, calls[0][1].length);

    const target = {};
    deep(5, () => Error.captureStackTrace(target));
    assertEquals('prepared 0', target.stack);
    assertEquals(2, calls.length);
    assertSame(target, calls[1][0]);

    let thrown;
    try { deep(5, () => null.x); } catch (e) { thrown = e; }
    assertEquals('prepared 0', thrown.stack);
    assertEquals(3, calls.length);
  } finally {
    delete Error.prepareStackTrace;
  }
})();

// The limit at capture time counts, not the limit when the stack is read.
(function TestLimitAtCaptureTime() {
  Error.stackTraceLimit = 0;
  const empty = deep(5, () => new Error('empty'));
  Error.stackTraceLimit = 3;
  const three = deep(5, () => new Error('three'));
  Error.stackTraceLimit = 0;
  assertEquals('Error: empty', empty.stack);
  assertEquals(4, three.stack.split('\n').length);
  Error.stackTraceLimit = 10;
  assertEquals('Error: empty', empty.stack);
})();

// Inside async functions and reactions there are no async frames either.
(function TestAsync() {
  let result;
  async function leaf() {
    await null;
    Error.stackTraceLimit = 0;
    const error = new Error('async');
    Error.stackTraceLimit = 10;
    return error;
  }
  async function caller() { return await leaf(); }
  caller().then(error => { result = error.stack; });
  %PerformMicrotaskCheckpoint();
  assertEquals('Error: async', result);
})();

// A limit that is not a number disables capturing instead.
(function TestNoCapture() {
  Error.stackTraceLimit = undefined;
  const error = deep(5, () => new Error('m'));
  assertStackAccessor(error);
  assertEquals(undefined, error.stack);
  const target = {};
  Error.captureStackTrace(target);
  assertStackAccessor(target);
  assertEquals(undefined, target.stack);
  Error.stackTraceLimit = 10;
})();

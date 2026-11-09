// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax

// Error objects reserve fields for the captured stack trace and for the
// message the constructor was called with. Check that both are written and
// read correctly for every layout an Error object can have.

function origin(make) { return make(); }
function recapture(error) { Error.captureStackTrace(error); }

function assertCapturedIn(name, error) {
  assertEquals('string', typeof error.stack);
  assertTrue(error.stack.includes('at ' + name + ' ('), error.stack);
}

// Checks that |error| holds the stack captured at construction, and that
// Error.captureStackTrace replaces it.
function checkStackIsReplaced(error, read_first = false) {
  if (read_first) {
    if (kCapturesNoFrames.has(error)) {
      assertEquals(1, error.stack.split('\n').length, error.stack);
    } else {
      assertCapturedIn('origin', error);
    }
  }
  recapture(error);
  assertCapturedIn('recapture', error);
  assertFalse(error.stack.includes('at origin ('), error.stack);
  %HeapObjectVerify(error);
  // And again, now that the stack has been formatted.
  origin(() => Error.captureStackTrace(error));
  assertCapturedIn('origin', error);
  assertFalse(error.stack.includes('at recapture ('), error.stack);
  %HeapObjectVerify(error);
}

class SubError extends Error {
  a = 1;
  b = 2;
  constructor(...args) {
    super(...args);
    this.c = 3;
  }
}

// With a new.target other than the constructor that was called, the capture
// skips frames until it reaches new.target's frame, which is never on the
// stack: the stack captured at construction has no frames.
const kCapturesNoFrames = new WeakSet();
function capturesNoFrames(make) {
  return () => {
    const error = make();
    kCapturesNoFrames.add(error);
    return error;
  };
}

const kFactories = [
  () => new Error('m'),
  () => new Error(),
  () => new Error('m', {cause: 1}),
  () => new Error(undefined, {cause: 1}),
  () => Error('m'),
  () => new TypeError('m'),
  () => new AggregateError([1], 'm'),
  () => new SubError('m'),
  () => new SubError(),
  capturesNoFrames(() => Reflect.construct(Error, ['m'], Object)),
  capturesNoFrames(() => Reflect.construct(RangeError, ['m'], SubError)),
  () => { try { null.x; } catch (e) { return e; } },
];

(function TestFreshErrors() {
  for (const make of kFactories) {
    const error = origin(make);
    assertTrue(%HasFastProperties(error));
    checkStackIsReplaced(error, true);
    checkStackIsReplaced(origin(make), false);
  }
})();

(function TestDictionaryModeErrors() {
  for (const make of kFactories) {
    const error = origin(make);
    error.x = 1;
    error.y = 2;
    delete error.x;
    assertFalse(%HasFastProperties(error));
    checkStackIsReplaced(error, true);
  }
})();

// Errors that went through dictionary mode and back have a different layout
// than fresh ones: deleting a property drops the in-object fields.
(function TestErrorsBackInFastMode() {
  for (const make of kFactories) {
    for (const read_first of [true, false]) {
      const error = origin(make);
      error.x = 1;
      error.y = 2;
      delete error.x;
      assertFalse(%HasFastProperties(error));
      %ToFastProperties(error);
      assertTrue(%HasFastProperties(error));
      checkStackIsReplaced(error, read_first);
      assertEquals(2, error.y);
    }
  }
})();

(function TestErrorWithoutStackAccessorBackInFastMode() {
  for (const make of kFactories) {
    const error = origin(make);
    delete error.stack;
    %ToFastProperties(error);
    assertFalse(Object.hasOwn(error, 'stack'));
    recapture(error);
    assertTrue(Object.hasOwn(error, 'stack'));
    assertCapturedIn('recapture', error);
    checkStackIsReplaced(error);
  }
})();

(function TestErrorsAsPrototypes() {
  for (const make of kFactories) {
    const error = origin(make);
    const child = Object.create(error);
    // Loading through the prototype chain turns the prototype into a fast
    // prototype map.
    for (let i = 0; i < 10; i++) assertEquals(error.message, child.message);
    checkStackIsReplaced(error, true);
    // The inherited accessor only looks at its receiver.
    assertEquals(undefined, child.stack);
  }
  // The same after the prototype was normalized.
  for (const make of kFactories) {
    const error = origin(make);
    delete error.stack;
    function Child() {}
    Child.prototype = error;
    for (let i = 0; i < 10; i++) assertEquals(error.message, new Child().message);
    recapture(error);
    checkStackIsReplaced(error);
    assertEquals(undefined, new Child().stack);
  }
})();

(function TestNonExtensibleErrors() {
  for (const integrity of [Object.preventExtensions, Object.seal,
                           Object.freeze]) {
    const error = origin(() => new Error('m'));
    integrity(error);
    assertThrows(() => recapture(error), TypeError);
    // The stack captured at construction is still there, and can still be
    // formatted and cached.
    assertCapturedIn('origin', error);
    assertCapturedIn('origin', error);
    %HeapObjectVerify(error);
  }
})();

(function TestStackSetterThenCapture() {
  const error = origin(() => new Error('m'));
  error.stack = 'custom';
  assertEquals('custom', error.stack);
  recapture(error);
  assertCapturedIn('recapture', error);
})();

(function TestManyCaptures() {
  const error = origin(() => new SubError('m'));
  for (let i = 0; i < 100; i++) {
    if (i % 2) recapture(error); else origin(() => recapture(error));
    if (i % 7 == 0) error.stack;
  }
  assertCapturedIn('recapture', error);
  assertFalse(error.stack.includes('at origin ('));
  %HeapObjectVerify(error);
})();

// The stack is formatted with the message the constructor was called with,
// not with the current value of the "message" property.
(function TestOriginalMessage() {
  function header(error) { return error.stack.split('\n')[0]; }
  for (const make of [() => new Error('original'),
                      () => Error('original'),
                      () => new SubError('original'),
                      () => new Error('original', {cause: 1}),
                      () => Reflect.construct(Error, ['original'], Object)]) {
    const error = make();
    error.message = 'changed';
    assertEquals('Error: original', header(error));
    %HeapObjectVerify(error);
  }
  {
    const error = new TypeError({toString() { return 'converted'; }});
    delete error.message;
    assertEquals('TypeError: converted', header(error));
  }
  {
    // Dictionary mode and back before the stack is formatted.
    const error = new RangeError('original');
    error.x = 1;
    error.y = 2;
    delete error.x;
    %ToFastProperties(error);
    error.message = 'changed';
    assertEquals('RangeError: original', header(error));
    recapture(error);
    assertEquals('RangeError: original', header(error));
  }
  {
    // No message at construction: the stack does not show a later one.
    const error = new Error();
    assertFalse(Object.hasOwn(error, 'message'));
    error.message = 'later';
    assertEquals('Error', header(error));
  }
  {
    // Not constructed by an Error constructor: the current message is used.
    const target = {name: 'Custom', message: 'first'};
    Error.captureStackTrace(target);
    target.message = 'second';
    assertEquals('Custom: second', header(target));
  }
})();

// The reserved fields are not observable as properties.
(function TestOwnKeys() {
  assertEquals(['stack'], Reflect.ownKeys(new Error()));
  assertEquals(['stack', 'message'], Reflect.ownKeys(new Error('m')));
  assertEquals(['stack', 'message', 'cause'],
               Reflect.ownKeys(new Error('m', {cause: 1})));
  assertEquals(['stack', 'cause'],
               Reflect.ownKeys(new Error(undefined, {cause: 1})));
  assertEquals(['stack', 'message', 'a', 'b', 'c'],
               Reflect.ownKeys(new SubError('m')));
  const target = {};
  Error.captureStackTrace(target);
  assertEquals(['stack'], Reflect.ownKeys(target));
  const error = new Error('m');
  recapture(error);
  assertEquals(['stack', 'message'], Reflect.ownKeys(error).sort().reverse());
})();

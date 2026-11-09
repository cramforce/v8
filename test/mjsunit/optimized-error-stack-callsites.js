// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax --maglev --turbofan

// A stack captured below optimized frames must describe the same call sites
// as the same stack captured below unoptimized frames: receiver, function,
// names, source position and constructor state. Each shape below is run
// unoptimized first, then again after requesting Maglev and TurboFan code for
// every function involved, and the leading frames are compared property by
// property.

function describe(error, depth) {
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (e, frames) => frames;
  const frames = error.stack;
  Error.prepareStackTrace = saved;
  assertTrue(frames.length >= depth);
  return frames.slice(0, depth).map(frame => ({
    receiver: frame.getThis(),
    func: frame.getFunction(),
    functionName: frame.getFunctionName(),
    methodName: frame.getMethodName(),
    typeName: frame.getTypeName(),
    line: frame.getLineNumber(),
    column: frame.getColumnNumber(),
    position: frame.getPosition(),
    isConstructor: frame.isConstructor(),
    isToplevel: frame.isToplevel(),
    text: frame.toString(),
  }));
}

// Receivers that are the same object in every run of a shape.
const fixedReceivers = new Set();

function assertSameFrames(expected, actual, name, tier) {
  assertEquals(expected.length, actual.length);
  for (let i = 0; i < expected.length; i++) {
    const where = `${name}, ${tier}, frame ${i}`;
    // Receiver and function are compared by identity, except for receivers
    // that are new per call: the wrapper a sloppy function gets for a
    // primitive receiver, and the object a constructor creates.
    const receiver = expected[i].receiver;
    if (receiver instanceof Number) {
      assertInstanceof(actual[i].receiver, Number, where);
      assertEquals(receiver.valueOf(), actual[i].receiver.valueOf(), where);
    } else if (typeof receiver === 'object' && receiver !== null &&
               !fixedReceivers.has(receiver)) {
      assertEquals('object', typeof actual[i].receiver, where);
      assertNotNull(actual[i].receiver, where);
      assertSame(Object.getPrototypeOf(receiver),
                 Object.getPrototypeOf(actual[i].receiver), where);
    } else {
      assertSame(expected[i].receiver, actual[i].receiver, where);
    }
    assertSame(expected[i].func, actual[i].func, where);
    for (const key of ['functionName', 'methodName', 'typeName', 'line',
                       'column', 'position', 'isConstructor', 'isToplevel',
                       'text']) {
      assertEquals(expected[i][key], actual[i][key], `${where}, ${key}`);
    }
  }
}

function check(name, functions, depth, run, names) {
  for (const f of functions) %PrepareFunctionForOptimization(f);
  run();
  const expected = describe(run(), depth);
  // The expectation itself must have the frames of the shape on top.
  assertEquals(functions[0].name, expected[0].functionName, name);
  if (names !== undefined) {
    assertEquals(names, expected.map(frame => frame.functionName), name);
  }

  for (const f of functions) %OptimizeMaglevOnNextCall(f);
  assertSameFrames(expected, describe(run(), depth), name, 'maglev');
  // A second capture takes the same path with warm lookup caches.
  assertSameFrames(expected, describe(run(), depth), name, 'maglev again');

  for (const f of functions) {
    %PrepareFunctionForOptimization(f);
    %OptimizeFunctionOnNextCall(f);
  }
  assertSameFrames(expected, describe(run(), depth), name, 'turbofan');
  assertSameFrames(expected, describe(run(), depth), name, 'turbofan again');
}

// One optimized frame, object receiver.
(function() {
  const receiver = {};
  fixedReceivers.add(receiver);
  function leaf() { return new Error(); }
  check('method receiver', [leaf], 1, () => leaf.call(receiver));
})();

// Sloppy function with a primitive receiver: the frame holds the wrapper.
(function() {
  function leaf() { return new Error(); }
  function caller() { return leaf.call(1.5); }
  check('sloppy primitive receiver', [leaf, caller], 2, () => caller());
})();

// Strict functions: a double receiver stays a primitive in the frame. The
// CallSite API hides receiver and function of strict frames.
(function() {
  function leaf() { 'use strict'; return new Error(); }
  function caller() { return leaf.call(2.5); }
  check('strict double receiver', [leaf, caller], 2, () => caller());
})();

// Sloppy frame below the strict one that poisons receiver and function.
(function() {
  const receiver = {};
  fixedReceivers.add(receiver);
  function leaf() { return new Error(); }
  function strictCaller() { 'use strict'; return leaf.call(receiver); }
  function sloppyCaller() { return strictCaller(); }
  check('strict poisoning', [leaf, strictCaller, sloppyCaller], 3,
        () => sloppyCaller());
})();

// Constructors: plain function, class, and a derived class that creates the
// error before super() has bound `this` (the receiver slot holds the hole).
(function() {
  function Ctor() { this.error = new Error(); }
  function caller() { return new Ctor().error; }
  check('function constructor', [Ctor, caller], 2, () => caller());
})();

(function() {
  class Base { constructor(error) { this.error = error; } }
  class Derived extends Base { constructor() { super(new Error()); } }
  function caller() { return new Derived().error; }
  check('derived constructor before super', [Derived, Base, caller], 2,
        () => caller());
})();

(function() {
  class Base { constructor() { this.error = new Error(); } }
  class Derived extends Base {}
  function caller() { return new Derived().error; }
  check('base constructor below default derived constructor',
        [Base, Derived, caller], 2, () => caller());
})();

// Reflect.construct with a different new.target.
(function() {
  function Ctor() { this.error = new Error(); }
  function NewTarget() {}
  function caller() { return Reflect.construct(Ctor, [], NewTarget).error; }
  check('Reflect.construct', [Ctor, caller], 2, () => caller());
})();

// A callee small enough to be inlined: the caller's frame then describes two
// functions, and the bytecode array of each comes from the deoptimization
// literals.
(function() {
  function inner() { return new Error(); }
  function middle() { return inner(); }
  function outer() { return middle(); }
  check('inlined callees', [inner, middle, outer], 3, () => outer());
})();

(function() {
  class Point { constructor() { this.error = new Error(); } }
  function make() { return new Point(); }
  function outer() { return make().error; }
  check('inlined constructor', [Point, make, outer], 3, () => outer());
})();

// A callback invoked by a builtin the optimizing compilers inline.
(function() {
  function callback() { return new Error(); }
  function caller() { return [0].map(callback)[0]; }
  check('array builtin callback', [callback, caller], 3, () => caller());
})();

// A frame that was marked for lazy deoptimization while it is on the stack.
(function() {
  function leaf() {
    %DeoptimizeFunction(victim);
    return new Error();
  }
  function victim() { return leaf(); }
  function caller() { return victim(); }
  check('lazily deoptimized caller', [leaf, victim, caller], 3,
        () => caller());
})();

// A function from another security origin between two functions of this
// one: its frame is dropped, whatever code it runs.
(function() {
  const crossOrigin = Realm.eval(
      Realm.create(), '(function crossOrigin(f) { return f(); })');
  function leaf() { return new Error(); }
  function outer() { return crossOrigin(leaf); }
  check('cross-origin caller', [leaf, crossOrigin, outer], 2, () => outer(),
        ['leaf', 'outer']);
})();

// The same with a realm that shares the security token: the frame stays.
(function() {
  const sameOrigin = Realm.eval(
      Realm.createAllowCrossRealmAccess(),
      '(function sameOrigin(f) { return f(); })');
  function leaf() { return new Error(); }
  function outer() { return sameOrigin(leaf); }
  check('same-origin caller', [leaf, sameOrigin, outer], 3, () => outer(),
        ['leaf', 'sameOrigin', 'outer']);
})();

// A limit smaller than the number of optimized frames.
(function() {
  function leaf() { return new Error(); }
  function middle() { return leaf(); }
  function outer() { return middle(); }
  function limited() {
    const saved = Error.stackTraceLimit;
    Error.stackTraceLimit = 2;
    try {
      return outer();
    } finally {
      Error.stackTraceLimit = saved;
    }
  }
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (e, frames) => frames;
  for (const f of [leaf, middle, outer]) %PrepareFunctionForOptimization(f);
  assertEquals(2, limited().stack.length);
  for (const f of [leaf, middle, outer]) %OptimizeFunctionOnNextCall(f);
  const frames = limited().stack;
  Error.prepareStackTrace = saved;
  assertEquals(['leaf', 'middle'], frames.map(f => f.getFunctionName()));
})();

// On-stack replacement: the frame that creates the error runs OSR code.
(function() {
  function loop(osr) {
    let error;
    for (let i = 0; i < 5; i++) {
      if (osr && i == 1) %OptimizeOsr();
      if (i == 4) error = new Error();
    }
    return error;
  }
  %PrepareFunctionForOptimization(loop);
  const expected = describe(loop(false), 1);
  assertSameFrames(expected, describe(loop(true), 1), 'osr', 'first');
  %PrepareFunctionForOptimization(loop);
  assertSameFrames(expected, describe(loop(true), 1), 'osr', 'second');
})();

// Error.captureStackTrace with a function to skip up to, from optimized code.
(function() {
  function leaf() {
    const target = {};
    Error.captureStackTrace(target, middle);
    return target;
  }
  function middle() { return leaf(); }
  function outer() { return middle(); }
  check('captureStackTrace skipping', [outer, middle, leaf], 1, () => outer());
})();

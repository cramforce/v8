// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax --maglev --turbofan
// Flags: --max-inlined-bytecode-size=0 --max-maglev-inlined-bytecode-size=0

// A derived class constructor is entered with the hole as its receiver; after
// super() `this` lives in a register. A CallSite for such a frame must see the
// bound receiver whether the constructor runs unoptimized or optimized (and
// not inlined, so that its frame is a single optimized frame).

function leaf() { return new Error(); }
class Base { constructor() { this.x = 1; } }
class Derived extends Base {
  constructor() {
    super();
    this.error = leaf();
  }
}
function caller() { return new Derived().error; }

function derivedFrame() {
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (e, frames) => frames;
  const frames = caller().stack;
  Error.prepareStackTrace = saved;
  const frame = frames[1];
  assertEquals('Derived', frame.getFunctionName());
  assertTrue(frame.isConstructor());
  return {toplevel: frame.isToplevel(), text: frame.toString()};
}

const fns = [leaf, Derived, caller];
for (const f of fns) %PrepareFunctionForOptimization(f);
const expected = derivedFrame();
assertFalse(expected.toplevel);
derivedFrame();

for (const f of fns) %OptimizeMaglevOnNextCall(f);
assertEquals(expected, derivedFrame());
assertEquals(expected, derivedFrame());

for (const f of fns) {
  %PrepareFunctionForOptimization(f);
  %OptimizeFunctionOnNextCall(f);
}
assertEquals(expected, derivedFrame());
assertEquals(expected, derivedFrame());

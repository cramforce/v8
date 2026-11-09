// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax --expose-gc --maglev --turbofan

// Stack capture resolves the deoptimization index of an optimized frame
// through the safepoint entry cached in the isolate's inner-pointer-to-code
// cache. That cache is direct-mapped and keyed by the frame's exact pc, so a
// slot must never answer for a pc other than the one it was filled for.

Error.prepareStackTrace = (error, frames) => frames;

function leaf() {
  return new Error();
}
%NeverOptimizeFunction(leaf);

function optimizeOnNextCall(f, tier) {
  if (tier === 'maglev') {
    %OptimizeMaglevOnNextCall(f);
  } else {
    %OptimizeFunctionOnNextCall(f);
  }
}

// More return addresses in one code object than the cache has slots (1024):
// some of them share a slot, so capturing them in turn keeps replacing
// entries. Every call site is on its own line.
const kSites = 1280;
function makeManySites(name) {
  let source = `(function ${name}(i) {\n  switch (i) {\n`;
  for (let i = 0; i < kSites; i++) source += `    case ${i}: return leaf();\n`;
  source += '  }\n})';
  return eval(source);
}

function assertSite(f, i) {
  const frames = f(i).stack;
  assertEquals('leaf', frames[0].getFunctionName());
  assertEquals(f.name, frames[1].getFunctionName());
  assertSame(f, frames[1].getFunction());
  assertEquals(i + 3, frames[1].getLineNumber());
}

for (const tier of ['maglev', 'turbofan']) {
  const manySites = makeManySites('manySites_' + tier);
  // Run every call site before optimizing; a site without feedback would
  // deoptimize the function when it is first reached.
  %PrepareFunctionForOptimization(manySites);
  for (let i = 0; i < kSites; i++) assertSite(manySites, i);
  optimizeOnNextCall(manySites, tier);
  // The first pass fills the cache, the second one hits or replaces.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < kSites; i++) assertSite(manySites, i);
  }
  // A full GC flushes the cache (and may move the code object).
  gc();
  for (let i = kSites - 1; i >= 0; i--) assertSite(manySites, i);
  assertOptimized(manySites);
}

// Lazily deoptimizing a function that is on the stack replaces the frame's
// return address by the trampoline's; the frame still reports the call site.
function testLazyDeoptimization(tier) {
  function deoptimizingLeaf(deoptimize) {
    if (deoptimize) %DeoptimizeFunction(caller);
    return new Error();
  }
  %NeverOptimizeFunction(deoptimizingLeaf);
  function caller(deoptimize) {
    return deoptimizingLeaf(deoptimize);
  }
  %PrepareFunctionForOptimization(caller);
  caller(false);
  caller(false);
  optimizeOnNextCall(caller, tier);
  const expected_line = caller(false).stack[1].getLineNumber();
  const expected_column = caller(false).stack[1].getColumnNumber();
  assertOptimized(caller);
  const frames = caller(true).stack;
  assertUnoptimized(caller);
  assertEquals('deoptimizingLeaf', frames[0].getFunctionName());
  assertSame(caller, frames[1].getFunction());
  assertEquals(expected_line, frames[1].getLineNumber());
  assertEquals(expected_column, frames[1].getColumnNumber());
}
testLazyDeoptimization('maglev');
testLazyDeoptimization('turbofan');

// One optimized frame with inlined functions yields the same frames on a
// cache miss and on a hit.
function inlined2() { return leaf(); }
function inlined1() { return inlined2(); }
function inliner() { return inlined1(); }
%PrepareFunctionForOptimization(inliner);
inliner();
inliner();
%OptimizeFunctionOnNextCall(inliner);
for (let i = 0; i < 3; i++) {
  const frames = inliner().stack;
  assertEquals(['leaf', 'inlined2', 'inlined1', 'inliner'],
               frames.slice(0, 4).map(frame => frame.getFunctionName()));
  if (i == 1) gc();
}
assertOptimized(inliner);

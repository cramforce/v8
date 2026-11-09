// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax

// Error.stackTraceLimit is read with the semantics of a side-effect free data
// property lookup on the Error constructor of the current realm: own data
// properties and data properties on the prototype chain count, accessors and
// proxies are never invoked and disable stack capturing, and so does every
// value that is not a number.

const kNoStack = -1;

// Runs |setup| in a fresh realm and returns the number of frames of an Error
// created below 21 recursive frames, or kNoStack if no stack was captured.
// The realm's global |log| records every user function that |setup| installed
// and that the lookup must not call.
function framesAfter(setup, check) {
  const realm = Realm.createAllowCrossRealmAccess();
  Realm.eval(realm, 'var log = [];');
  Realm.eval(realm, setup);
  if (check !== undefined) check(Realm.global(realm));
  const frames = Realm.eval(realm, `
    (function() {
      function deep(n) { return n > 0 ? deep(n - 1) : new Error('x'); }
      const stack = deep(20).stack;
      if (log.length !== 0) throw new Error('unexpected call: ' + log);
      return stack === undefined ? ${kNoStack} : stack.split('\\n').length - 1;
    })()`);
  Realm.dispose(realm);
  return frames;
}

function isFast(global) { assertTrue(%HasFastProperties(global.Error)); }
function isSlow(global) { assertFalse(%HasFastProperties(global.Error)); }

const kGetter = `Object.defineProperty(Error, 'stackTraceLimit', {
    get() { log.push('get'); return 3; },
    set(v) { log.push('set'); },
    configurable: true});`;
const kProxyPrototype = `Object.setPrototypeOf(Error, new Proxy(
    {stackTraceLimit: 3}, {
      get(t, k, r) {
        if (k === 'stackTraceLimit') log.push('proxy get');
        return Reflect.get(t, k, r);
      },
      has(t, k) {
        if (k === 'stackTraceLimit') log.push('proxy has');
        return Reflect.has(t, k);
      },
      getOwnPropertyDescriptor(t, k) {
        if (k === 'stackTraceLimit') log.push('proxy getOwnPropertyDescriptor');
        return Reflect.getOwnPropertyDescriptor(t, k);
      }
    }));`;
// Deleting a property that is not the most recently added one puts the
// constructor into dictionary mode.
const kMakeSlow = 'Error.a = 1; Error.b = 2; delete Error.a;';

// The default.
assertEquals(10, framesAfter('', isFast));

// Numbers: truncated towards zero, negative and NaN mean zero frames, large
// values are clamped.
assertEquals(3, framesAfter('Error.stackTraceLimit = 3;', isFast));
assertEquals(0, framesAfter('Error.stackTraceLimit = 0;', isFast));
assertEquals(0, framesAfter('Error.stackTraceLimit = -0;'));
assertEquals(0, framesAfter('Error.stackTraceLimit = -1;'));
assertEquals(0, framesAfter('Error.stackTraceLimit = -Infinity;'));
assertEquals(0, framesAfter('Error.stackTraceLimit = NaN;'));
assertEquals(0, framesAfter('Error.stackTraceLimit = 0.9;'));
assertEquals(2, framesAfter('Error.stackTraceLimit = 2.9;', isFast));
assertEquals(21, framesAfter('Error.stackTraceLimit = 21;'));
assertTrue(framesAfter('Error.stackTraceLimit = Infinity;') > 21);
assertTrue(framesAfter('Error.stackTraceLimit = 1e12;') > 21);
assertTrue(framesAfter('Error.stackTraceLimit = 2 ** 31;') > 21);

// The field changes representation.
assertEquals(7, framesAfter(
    'Error.stackTraceLimit = 2.5; Error.stackTraceLimit = 7;', isFast));
assertEquals(2, framesAfter(
    'Error.stackTraceLimit = 7; Error.stackTraceLimit = 2.5;', isFast));
assertEquals(4, framesAfter(`
    Error.stackTraceLimit = 1.5; Error.stackTraceLimit = {};
    Error.stackTraceLimit = 4;`, isFast));

// Values that are not numbers are not converted and disable stack capturing.
for (const value of ['"5"', '""', 'undefined', 'null', 'true', '5n',
                     'new Number(5)', '[5]', 'Symbol()']) {
  assertEquals(kNoStack, framesAfter(`Error.stackTraceLimit = ${value};`));
}
assertEquals(kNoStack, framesAfter(`Error.stackTraceLimit = {
    valueOf() { log.push('valueOf'); return 3; },
    toString() { log.push('toString'); return '3'; },
    [Symbol.toPrimitive]() { log.push('toPrimitive'); return 3; }};`));

// Attributes do not matter.
assertEquals(3, framesAfter(`Object.defineProperty(Error, 'stackTraceLimit',
    {value: 3, writable: false, enumerable: false, configurable: false});`));
assertEquals(4, framesAfter(
    'Error.stackTraceLimit = 4; Object.freeze(Error);', isFast));
assertEquals(4, framesAfter(
    'Error.stackTraceLimit = 4; Object.seal(Error);'));

// Accessors are not called. Redefining the existing data property as an
// accessor normalizes the constructor, adding the accessor after a delete
// keeps it in fast mode.
assertEquals(kNoStack, framesAfter(kGetter, isSlow));
assertEquals(
    kNoStack, framesAfter('delete Error.stackTraceLimit;' + kGetter, isFast));
assertEquals(kNoStack, framesAfter(`
    Object.defineProperty(Error, 'stackTraceLimit',
        {set(v) { log.push('set'); }, configurable: true});`));
// An own accessor hides a data property on the prototype chain.
assertEquals(kNoStack, framesAfter(
    'Function.prototype.stackTraceLimit = 3;' + kGetter));
// An accessor that is replaced by a data property again.
assertEquals(6, framesAfter(kGetter + `
    Object.defineProperty(Error, 'stackTraceLimit',
        {value: 6, writable: true, configurable: true});`));

// Deleted: the lookup continues on the prototype chain.
assertEquals(kNoStack, framesAfter('delete Error.stackTraceLimit;'));
assertEquals(4, framesAfter(
    'delete Error.stackTraceLimit; Error.stackTraceLimit = 4;'));
assertEquals(3, framesAfter(`
    delete Error.stackTraceLimit; Function.prototype.stackTraceLimit = 3;`));
assertEquals(2, framesAfter(`
    delete Error.stackTraceLimit; Object.prototype.stackTraceLimit = 2;`));
assertEquals(3, framesAfter(`
    delete Error.stackTraceLimit; Function.prototype.stackTraceLimit = 3;
    Object.prototype.stackTraceLimit = 2;`));
assertEquals(kNoStack, framesAfter(`
    delete Error.stackTraceLimit; Function.prototype.stackTraceLimit = 'x';
    Object.prototype.stackTraceLimit = 2;`));
assertEquals(kNoStack, framesAfter(`
    delete Error.stackTraceLimit;
    Object.defineProperty(Function.prototype, 'stackTraceLimit',
        {get() { log.push('get'); return 3; }, configurable: true});
    Object.prototype.stackTraceLimit = 2;`));
// The own property wins over the prototype chain.
assertEquals(6, framesAfter(`
    Function.prototype.stackTraceLimit = 3; Error.stackTraceLimit = 6;`));

// A changed prototype.
assertEquals(4, framesAfter(`
    delete Error.stackTraceLimit;
    Object.setPrototypeOf(Error, {stackTraceLimit: 4});`));
assertEquals(6, framesAfter(`
    Error.stackTraceLimit = 6;
    Object.setPrototypeOf(Error, {stackTraceLimit: 4});`));
assertEquals(kNoStack, framesAfter(`
    delete Error.stackTraceLimit; Object.setPrototypeOf(Error, null);`));
assertEquals(6, framesAfter(`
    Error.stackTraceLimit = 6; Object.setPrototypeOf(Error, null);`));
// Proxies on the prototype chain are not consulted.
assertEquals(kNoStack, framesAfter(
    'delete Error.stackTraceLimit;' + kProxyPrototype));
assertEquals(6, framesAfter('Error.stackTraceLimit = 6;' + kProxyPrototype));

// The same with the constructor in dictionary mode.
assertEquals(10, framesAfter(kMakeSlow, isSlow));
assertEquals(3, framesAfter(kMakeSlow + 'Error.stackTraceLimit = 3;', isSlow));
assertEquals(0, framesAfter(kMakeSlow + 'Error.stackTraceLimit = 0;', isSlow));
assertEquals(2, framesAfter(
    kMakeSlow + 'Error.stackTraceLimit = 2.5;', isSlow));
assertTrue(framesAfter(
    kMakeSlow + 'Error.stackTraceLimit = Infinity;', isSlow) > 21);
assertEquals(kNoStack, framesAfter(
    kMakeSlow + 'Error.stackTraceLimit = "3";', isSlow));
assertEquals(kNoStack, framesAfter(kMakeSlow + kGetter, isSlow));
assertEquals(kNoStack, framesAfter(
    kMakeSlow + 'Function.prototype.stackTraceLimit = 3;' + kGetter, isSlow));
assertEquals(kNoStack, framesAfter(
    kMakeSlow + 'delete Error.stackTraceLimit;', isSlow));
assertEquals(3, framesAfter(kMakeSlow + `
    delete Error.stackTraceLimit; Function.prototype.stackTraceLimit = 3;`,
    isSlow));
assertEquals(kNoStack, framesAfter(kMakeSlow + `
    delete Error.stackTraceLimit; Object.setPrototypeOf(Error, null);`,
    isSlow));
assertEquals(kNoStack, framesAfter(
    kMakeSlow + 'delete Error.stackTraceLimit;' + kProxyPrototype, isSlow));
assertEquals(4, framesAfter(
    kMakeSlow + 'Error.stackTraceLimit = 4; Object.freeze(Error);', isSlow));
// Deleting the limit itself is what makes the constructor slow.
assertEquals(kNoStack, framesAfter(
    'Error.z = 1; delete Error.stackTraceLimit;', isSlow));

// Only the Error constructor is consulted, also for other error types,
// subclasses and errors created by the runtime.
assertEquals(10, framesAfter(`
    TypeError.stackTraceLimit = 1; RangeError.stackTraceLimit = 'x';`));
(function TestOtherConstructors() {
  const realm = Realm.createAllowCrossRealmAccess();
  const frames = Realm.eval(realm, `
    Error.stackTraceLimit = 3;
    TypeError.stackTraceLimit = 1;
    class Sub extends Error {}
    Sub.stackTraceLimit = 2;
    function deep(n, f) { return n > 0 ? deep(n - 1, f) : f(); }
    function count(e) { return e.stack.split('\\n').length - 1; }
    let thrown;
    try { deep(20, () => null.x); } catch (e) { thrown = e; }
    const target = {};
    deep(20, () => Error.captureStackTrace(target));
    [count(deep(20, () => new TypeError('x'))),
     count(deep(20, () => new Sub('x'))),
     count(deep(20, () => Error('x'))),
     count(thrown), count(target)].join()`);
  assertEquals('3,3,3,3,3', frames);
  Realm.dispose(realm);
})();

// The limit of the realm of the called constructor is used.
(function TestCrossRealm() {
  const realm_a = Realm.createAllowCrossRealmAccess();
  const realm_b = Realm.createAllowCrossRealmAccess();
  const A = Realm.global(realm_a);
  const B = Realm.global(realm_b);
  A.B = B;
  Realm.eval(realm_a, `
    Error.stackTraceLimit = 2;
    function deep(n, f) { return n > 0 ? deep(n - 1, f) : f(); }
    function count(e) {
      return e.stack === undefined ? ${kNoStack}
                                   : e.stack.split('\\n').length - 1;
    }`);
  Realm.eval(realm_b, 'Error.stackTraceLimit = 6;');
  assertEquals(2, Realm.eval(realm_a, 'count(deep(20, () => new Error("x")))'));
  assertEquals(
      6, Realm.eval(realm_a, 'count(deep(20, () => new B.Error("x")))'));
  assertEquals(
      6, Realm.eval(realm_a, 'count(deep(20, () => new B.TypeError("x")))'));
  assertEquals(6, Realm.eval(realm_a, `
      count(deep(20, () => Reflect.construct(B.Error, ['x'], Error)))`));
  assertEquals(2, Realm.eval(realm_a, `
      count(deep(20, () => Reflect.construct(Error, ['x'], B.Error)))`));
  assertEquals(6, Realm.eval(realm_a, `
      (() => { const o = {}; deep(20, () => B.Error.captureStackTrace(o));
               return count(o); })()`));
  // Changing the other realm's constructor does not affect this realm.
  Realm.eval(realm_b, 'delete Error.stackTraceLimit;');
  assertEquals(2, Realm.eval(realm_a, 'count(deep(20, () => new Error("x")))'));
  assertEquals(
      kNoStack, Realm.eval(realm_a, 'count(deep(20, () => new B.Error("x")))'));
  Realm.eval(realm_b, 'Function.prototype.stackTraceLimit = 4;');
  assertEquals(
      4, Realm.eval(realm_a, 'count(deep(20, () => new B.Error("x")))'));
  Realm.dispose(realm_a);
  Realm.dispose(realm_b);
})();

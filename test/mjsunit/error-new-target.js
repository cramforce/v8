// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax

// Error constructors create their result with
// OrdinaryCreateFromConstructor(newTarget, "%Error.prototype%"): the
// prototype comes from new.target, falling back to the intrinsic of
// new.target's realm, and the object is an Error whatever new.target is.

const kConstructors = [Error, EvalError, RangeError, ReferenceError,
                       SyntaxError, TypeError, URIError];

function assertIsError(error, prototype) {
  assertSame(prototype, Object.getPrototypeOf(error));
  assertEquals('[object Error]', Object.prototype.toString.call(error));
  assertEquals(['stack', 'message'], Reflect.ownKeys(error));
  assertEquals('m', error.message);
  assertEquals('string', typeof error.stack);
  %HeapObjectVerify(error);
}

(function TestNewAndCall() {
  for (const C of kConstructors) {
    assertIsError(new C('m'), C.prototype);
    // Called as a function, new.target is the active function.
    assertIsError(C('m'), C.prototype);
    assertIsError(C.call({}, 'm'), C.prototype);
    assertIsError(Reflect.construct(C, ['m']), C.prototype);
    assertIsError(Reflect.construct(C, ['m'], C), C.prototype);
    assertIsError(new (C.bind(null))('m'), C.prototype);
    assertIsError(new (C.bind(null, 'm'))(), C.prototype);
    // The fresh object does not share anything with previous ones.
    const first = new C('m');
    first.extra = 1;
    assertEquals(['stack', 'message'], Reflect.ownKeys(new C('m')));
    assertTrue(%HaveSameMap(new C('m'), new C('m')));
  }
})();

(function TestSubclasses() {
  for (const C of kConstructors) {
    class Sub extends C {}
    assertIsError(new Sub('m'), Sub.prototype);
    assertTrue(new Sub('m') instanceof C);
    class SubSub extends Sub {}
    assertIsError(new SubSub('m'), SubSub.prototype);
    // The base constructor keeps producing plain instances.
    assertIsError(new C('m'), C.prototype);
    assertFalse(%HaveSameMap(new C('m'), new Sub('m')));
  }
})();

(function TestOtherNewTargets() {
  for (const C of kConstructors) {
    for (const NewTarget of [Object, Array, Function, function() {},
                             class {}, Error, TypeError]) {
      if (NewTarget === C) continue;
      const error = Reflect.construct(C, ['m'], NewTarget);
      assertIsError(error, NewTarget.prototype);
      assertFalse(Array.isArray(error));
      // Interleave with plain construction.
      assertIsError(new C('m'), C.prototype);
    }
    // A function that already has an initial map of its own.
    function Used() { this.own = 1; }
    new Used();
    assertIsError(Reflect.construct(C, ['m'], Used), Used.prototype);
    assertEquals(['own'], Reflect.ownKeys(new Used()));

    // Proxies forward the "prototype" lookup to their target.
    assertIsError(new (new Proxy(C, {}))('m'), C.prototype);
    assertIsError(Reflect.construct(C, ['m'], new Proxy(C, {})), C.prototype);
    assertIsError(Reflect.construct(C, ['m'], C.bind(null)), C.prototype);
    // Bound functions have no "prototype": the intrinsic is used.
    assertIsError(Reflect.construct(C, ['m'], Array.bind(null)), C.prototype);
    const proxy_prototype = {};
    assertIsError(Reflect.construct(C, ['m'], new Proxy(function() {}, {
      get(target, key, receiver) {
        return key === 'prototype' ? proxy_prototype
                                   : Reflect.get(target, key, receiver);
      }
    })), proxy_prototype);

    // A new.target whose prototype changes.
    function Changing() {}
    const first_prototype = Changing.prototype;
    assertIsError(Reflect.construct(C, ['m'], Changing), first_prototype);
    Changing.prototype = {second: true};
    assertIsError(Reflect.construct(C, ['m'], Changing), Changing.prototype);
    Changing.prototype = null;
    assertIsError(Reflect.construct(C, ['m'], Changing), C.prototype);
    Changing.prototype = 1;
    assertIsError(Reflect.construct(C, ['m'], Changing), C.prototype);
  }
})();

(function TestNewTargetErrors() {
  class Sentinel {}
  const throwing = new Proxy(function() {}, {
    get(target, key, receiver) {
      if (key === 'prototype') throw new Sentinel();
      return Reflect.get(target, key, receiver);
    }
  });
  let converted = false;
  const message = {toString() { converted = true; return 'm'; }};
  assertThrows(() => Reflect.construct(Error, [message], throwing), Sentinel);
  // The object is created before the message is converted.
  assertFalse(converted);
  assertThrows(() => Reflect.construct(Error, ['m'], () => {}), TypeError);
  assertThrows(() => Reflect.construct(Error, ['m'], {}), TypeError);
})();

(function TestCrossRealm() {
  const realm = Realm.createAllowCrossRealmAccess();
  const other = Realm.global(realm);
  for (const C of kConstructors) {
    const OtherC = other[C.name];
    assertNotSame(C, OtherC);
    assertIsError(new OtherC('m'), OtherC.prototype);
    assertIsError(OtherC('m'), OtherC.prototype);
    assertIsError(Reflect.construct(C, ['m'], OtherC), OtherC.prototype);
    assertIsError(Reflect.construct(OtherC, ['m'], C), C.prototype);
    assertIsError(Reflect.construct(C, ['m'], other.Object),
                  other.Object.prototype);
    // Without a usable prototype, the intrinsic of new.target's realm is
    // used, for the constructor that was called.
    const other_function = new other.Function();
    other_function.prototype = null;
    assertIsError(Reflect.construct(C, ['m'], other_function),
                  OtherC.prototype);
    const own_function = function() {};
    own_function.prototype = undefined;
    assertIsError(Reflect.construct(OtherC, ['m'], own_function), C.prototype);
    class Sub extends OtherC {}
    assertIsError(new Sub('m'), Sub.prototype);
    assertTrue(new Sub('m') instanceof OtherC);
    assertFalse(new Sub('m') instanceof C);
  }
  Realm.dispose(realm);
})();

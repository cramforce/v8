// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax

// The Error constructors create "message" with
// CreateNonEnumerableDataPropertyOrThrow: an own, writable, non-enumerable,
// configurable data property that is defined, not set, and that only exists
// if the message argument is not undefined.

function assertMessage(expected, error) {
  assertEquals(
      {value: expected, writable: true, enumerable: false, configurable: true},
      Object.getOwnPropertyDescriptor(error, 'message'));
  %HeapObjectVerify(error);
}

class SubError extends Error {
  field = 1;
}
function OldStyle(message) {
  return Reflect.construct(Error, [message], OldStyle);
}
OldStyle.prototype = Object.create(Error.prototype);

const kConstructors = [
  Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError,
  URIError, SubError, OldStyle,
  function ErrorCalled(message) { return Error(message); },
  function WithObjectNewTarget(message) {
    return Reflect.construct(TypeError, [message], Object);
  },
  function WithProxyNewTarget(message) {
    return new (new Proxy(RangeError, {}))(message);
  },
  function WithBoundNewTarget(message) {
    return new (Error.bind(null))(message);
  },
  function Aggregate(message) { return new AggregateError([], message); },
];

(function TestPresenceAndAttributes() {
  for (const C of kConstructors) {
    assertMessage('m', new C('m'));
    assertMessage('', new C(''));
    assertMessage('null', new C(null));
    assertMessage('42', new C(42));
    assertMessage('1.5', new C(1.5));
    assertMessage('true', new C(true));
    assertMessage('10', new C(10n));
    assertMessage('[object Object]', new C({}));
    assertMessage('1,2', new C([1, 2]));
    assertMessage('converted', new C({toString() { return 'converted'; }}));
    assertFalse(Object.hasOwn(new C(), 'message'));
    assertFalse(Object.hasOwn(new C(undefined), 'message'));
  }
  assertEquals('', new Error().message);
  assertEquals('', new SubError().message);
})();

(function TestKeyOrder() {
  assertEquals(['stack'], Reflect.ownKeys(new Error()));
  assertEquals(['stack', 'message'], Reflect.ownKeys(new Error('m')));
  assertEquals(['stack', 'message', 'cause'],
               Reflect.ownKeys(new Error('m', {cause: 0})));
  assertEquals(['stack', 'cause'],
               Reflect.ownKeys(new Error(undefined, {cause: 0})));
  assertEquals(['stack', 'message', 'field'],
               Reflect.ownKeys(new SubError('m')));
  assertEquals(['stack', 'field'], Reflect.ownKeys(new SubError()));
  assertEquals(['stack', 'message', 'errors'],
               Reflect.ownKeys(new AggregateError([], 'm')));
  assertEquals(['stack', 'message', 'cause', 'errors'],
               Reflect.ownKeys(new AggregateError([], 'm', {cause: 0})));
  assertEquals([], Object.keys(new Error('m', {cause: 0})));
})();

(function TestConversionOrderAndFailures() {
  const log = [];
  const options = new Proxy({cause: 1}, {
    has(target, key) { log.push('has ' + key); return key in target; },
    get(target, key) { log.push('get ' + key); return target[key]; },
  });
  const message = {toString() { log.push('toString'); return 'm'; }};
  const error = new Error(message, options);
  assertEquals(['toString', 'has cause', 'get cause'], log);
  assertMessage('m', error);

  assertThrows(() => new Error(Symbol()), TypeError);
  class Sentinel {}
  assertThrows(
      () => new Error({toString() { throw new Sentinel(); }}), Sentinel);
  assertThrows(() => new Error({toString() { return {}; },
                                valueOf() { return {}; }}), TypeError);
})();

// "message" is defined, so neither accessors nor read-only properties on
// the prototype chain get in the way.
(function TestPrototypeChainIsNotConsulted() {
  function withProperty(object, descriptor, body) {
    const old = Object.getOwnPropertyDescriptor(object, 'message');
    Object.defineProperty(object, 'message', {configurable: true, ...descriptor});
    try {
      body();
    } finally {
      if (old === undefined) {
        delete object.message;
      } else {
        Object.defineProperty(object, 'message', old);
      }
    }
  }
  const fail = () => { throw new Error('unreachable'); };
  for (const descriptor of [{get: fail, set: fail}, {set: fail},
                            {get() { return 'inherited'; }},
                            {value: 'read-only', writable: false}]) {
    for (const holder of [Error.prototype, Object.prototype,
                          SubError.prototype, TypeError.prototype]) {
      withProperty(holder, descriptor, () => {
        for (const C of kConstructors) assertMessage('own', new C('own'));
        let thrown;
        try { null.x; } catch (e) { thrown = e; }
        assertTrue(Object.hasOwn(thrown, 'message'));
        assertEquals('string', typeof Object.getOwnPropertyDescriptor(
            thrown, 'message').value);
      });
    }
  }
})();

// Errors with a message share one map per constructor, whatever the string
// representation of the message.
(function TestMaps() {
  for (const C of [Error, TypeError, SubError]) {
    const errors = [
      new C('one-byte'), new C('two-byte ሴ'), new C('x'.repeat(100) + 1),
      new C('0123456789abcdefghij'.slice(2, 18)), new C(5), new C({}),
      new C(new String('wrapped')), new C(''),
    ];
    for (const error of errors) {
      assertTrue(%HasFastProperties(error));
      assertTrue(%HaveSameMap(errors[0], error));
    }
    assertFalse(%HaveSameMap(errors[0], new C()));
    assertTrue(%HaveSameMap(new C(), new C(undefined)));
  }
})();

// Other code can create the transition that the constructor follows, with a
// different field representation or with different attributes.
(function TestExistingTransitions() {
  class DoubleFirst extends Error {}
  const first = new DoubleFirst();
  Object.defineProperty(first, 'message',
      {value: 1.5, writable: true, enumerable: false, configurable: true});
  const second = new DoubleFirst('string');
  assertMessage('string', second);
  assertMessage(1.5, first);
  first.message = 2.5;
  assertMessage(2.5, first);
  assertMessage('again', new DoubleFirst('again'));

  class SmiFirst extends Error {}
  const smi = new SmiFirst();
  Object.defineProperty(smi, 'message',
      {value: 1, writable: true, enumerable: false, configurable: true});
  assertMessage('string', new SmiFirst('string'));
  assertMessage(1, smi);

  class EnumerableFirst extends Error {}
  const enumerable = new EnumerableFirst();
  enumerable.message = 'assigned';
  assertEquals(['message'], Object.keys(enumerable));
  assertMessage('string', new EnumerableFirst('string'));
  assertEquals(['message'], Object.keys(enumerable));

  class AccessorFirst extends Error {}
  const accessor = new AccessorFirst();
  Object.defineProperty(accessor, 'message',
      {get() { return 'getter'; }, configurable: true});
  assertMessage('string', new AccessorFirst('string'));
  assertEquals('getter', accessor.message);

  // Generalize the field of errors that already exist.
  const before = new URIError('before');
  const number = new URIError('number');
  number.message = 0.5;
  const object = new URIError('object');
  object.message = {};
  const after = new URIError('after');
  assertMessage('before', before);
  assertMessage(0.5, number);
  assertMessage('after', after);
  assertEquals('object', typeof object.message);
  assertTrue(%HaveSameMap(before, after));
})();

// Converting the message runs user code before the property is added.
(function TestSideEffectsDuringConversion() {
  const error = new EvalError({
    toString() {
      for (let i = 0; i < 4; i++) {
        const inner = new EvalError('inner');
        inner.message = i / 2;
        delete inner.message;
        inner.message = 'again';
        Object.defineProperty(new EvalError(), 'message',
            {value: {}, writable: true, enumerable: i % 2 == 0,
             configurable: true});
      }
      EvalError.prototype.added = 1;
      return 'outer';
    }
  });
  assertMessage('outer', error);
  assertEquals(['stack', 'message'], Reflect.ownKeys(error));
  delete EvalError.prototype.added;

  const proto = Object.getPrototypeOf(RangeError.prototype);
  const range_error = new RangeError({
    toString() {
      Object.setPrototypeOf(RangeError.prototype, {marker: true});
      return 'reparented';
    }
  });
  assertMessage('reparented', range_error);
  assertTrue(range_error.marker);
  Object.setPrototypeOf(RangeError.prototype, proto);
})();

// The property behaves like any other data property afterwards.
(function TestLaterChanges() {
  const error = new Error('m');
  error.message = 'changed';
  assertMessage('changed', error);
  assertTrue(delete error.message);
  assertFalse(Object.hasOwn(error, 'message'));
  assertEquals('', error.message);
  error.message = 'assigned';
  assertEquals(
      {value: 'assigned', writable: true, enumerable: true, configurable: true},
      Object.getOwnPropertyDescriptor(error, 'message'));

  const frozen = Object.freeze(new Error('frozen'));
  assertEquals(
      {value: 'frozen', writable: false, enumerable: false,
       configurable: false},
      Object.getOwnPropertyDescriptor(frozen, 'message'));
})();

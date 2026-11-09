// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax --async-stack-traces

// Error.stackTraceLimit bounds synchronous and async frames together: async
// frames are only appended while the limit has not been reached.

function frames(error) {
  return error.stack.split('\n').slice(1).map(line => {
    const match = /^\s+at (async )?(?:Promise\.)?([\w$]+)/.exec(line);
    return (match[1] ?? '') + match[2];
  });
}

// Creates an error below three synchronous frames, after an await, called
// through three async functions.
function sync3() { return new Error(); }
function sync2() { return sync3(); }
function sync1() { return sync2(); }
async function async3() {
  await null;
  return sync1();
}
async function async2() { return await async3(); }
async function async1() { return await async2(); }

const kAllFrames = ['sync3', 'sync2', 'sync1', 'async3', 'async async2',
                    'async async1', 'async run', 'async main'];

async function run(limit) {
  Error.stackTraceLimit = limit;
  try {
    return frames(await async1());
  } finally {
    Error.stackTraceLimit = 10;
  }
}

async function runPromiseAll(limit) {
  async function leaf() {
    await null;
    Error.stackTraceLimit = limit;
    try {
      return sync1();
    } finally {
      Error.stackTraceLimit = 10;
    }
  }
  async function combinator() { return (await Promise.all([leaf()]))[0]; }
  return frames(await combinator());
}

async function main() {
  // No limit in the way.
  assertEquals(kAllFrames, await run(10));
  assertEquals(kAllFrames, await run(Infinity));
  assertEquals(kAllFrames, await run(kAllFrames.length));
  // Every limit below that cuts the list off, in the synchronous part, at
  // the boundary (limits 3 and 4), or in the async part.
  for (let limit = 0; limit < kAllFrames.length; limit++) {
    assertEquals(kAllFrames.slice(0, limit), await run(limit));
    assertEquals(kAllFrames.slice(0, limit), await run(limit + 0.5));
  }
  assertEquals([], await run(-1));

  // The same for the frame of a promise combinator.
  const kCombinatorFrames =
      ['sync3', 'sync2', 'sync1', 'leaf', 'async all', 'async combinator',
       'async runPromiseAll', 'async main'];
  assertEquals(kCombinatorFrames, await runPromiseAll(10));
  for (let limit = 0; limit < kCombinatorFrames.length; limit++) {
    assertEquals(
        kCombinatorFrames.slice(0, limit), await runPromiseAll(limit));
  }

  // The same for Error.captureStackTrace and for errors thrown by the
  // runtime.
  async function capture(limit) {
    await null;
    const target = {};
    Error.stackTraceLimit = limit;
    Error.captureStackTrace(target);
    Error.stackTraceLimit = 10;
    return frames(target);
  }
  async function captureCaller(limit) { return await capture(limit); }
  assertEquals(['capture', 'async captureCaller', 'async main'],
               await captureCaller(10));
  assertEquals(['capture', 'async captureCaller'], await captureCaller(2));
  assertEquals(['capture'], await captureCaller(1));
  assertEquals([], await captureCaller(0));

  async function thrower(limit) {
    await null;
    Error.stackTraceLimit = limit;
    try {
      null.x;
    } catch (e) {
      return frames(e);
    } finally {
      Error.stackTraceLimit = 10;
    }
  }
  async function throwerCaller(limit) { return await thrower(limit); }
  assertEquals(['thrower', 'async throwerCaller', 'async main'],
               await throwerCaller(10));
  assertEquals(['thrower', 'async throwerCaller'], await throwerCaller(2));
  assertEquals(['thrower'], await throwerCaller(1));
  assertEquals([], await throwerCaller(0));
}

assertPromiseResult(main());

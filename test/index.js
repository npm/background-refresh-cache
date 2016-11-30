"use strict";

const tap = require('tap');
const P = require('bluebird');

const requireInject = require('require-inject');
const redis = require('redis-mock');
const pool = requireInject.installGlobally.andClearCache('@npmcorp/redis-pool', {
  redis
});
const Cache = require('../');

let numCalled = 0;

let getFoo = function (key) {
  numCalled++;

  if (key === "forceError") {
    return P.reject(new Error('kablooey'));
  } else if (key === "forceNotFound") {
    return P.reject(Object.assign(new Error('not found'), {statusCode: 404}));
  }

  return P.resolve({value: 'ohai'});
};

var cache = new Cache('foo', getFoo, 0.1); 

tap.test('cache instantiates with a name, function, and ttl', t => {
  t.equals(numCalled, 0);
  t.equals(cache.ttl, 0.1);
  t.equals(cache.name, 'foo');
  t.type(getFoo, 'function');
  t.done()
});

tap.test('getting from cache requires a fetch on first try', t => {
  cache.get('boom').then(cached => {
    t.equals(numCalled, 1);
    t.ok(cached);
    t.equal(cached.value, 'ohai');
    t.done();
  });
});

tap.test('getting from cache does not require a fetch on second try', t => {
  const doneFetching = deferred();
  cache.get('boom').then(cached => {
    t.equals(numCalled, 1);
    t.ok(cached);
    t.equal(cached.value, 'ohai');
    P.delay(200).then(() => {
      cache.once('fetch', () => {
        t.equals(numCalled, 2);
        doneFetching.resolve();
      });
      P.join(cache.get('boom').then(cached => {
      }), doneFetching.promise).then(() => t.done());
    });
  });
});

tap.test("ensure backwards capability after fixing a bug", t => {
  return pool.withConnection(redis => {
    const obj = {
      bang: 'blerg'
    };

    return redis.setAsync('foo:twiddle', JSON.stringify(obj));
  })
    .then(() => cache.get('twiddle'))
    .then(cached => {
      t.equals(cached.value, 'ohai');
      t.equals(numCalled, 3);
    })
});

tap.test("delete from cache if not found", t => {
  return pool.withConnection(redis => {
    const obj = {
      value: 'blerg',
      fetchedAt: 1 // force that fetch!
    };

    const doneFetching = deferred();
    cache.once('fetch', doneFetching.resolve);

    return redis.setAsync('foo:forceNotFound', JSON.stringify(obj))
      .then(() => cache.get('forceNotFound'))
      .then(cached => doneFetching.promise
        .catch(err => {
          t.ok(err)
          t.equal(err.statusCode, 404)
        })
        .then(() => redis.getAsync('foo:forceNotFound')))
      .then(result => t.notOk(result))
      
  });
});

tap.test("errors are passed through verbatim", t => {
  return cache.get("forceError")
    .catch(err => {
      t.ok(err);
      t.equals(err.message, "kablooey");
    });
});

tap.test('wrapping up...', t => {
  pool.drain().then(() => pool.clear());
  t.done();
});

function deferred() {
  let resolve;
  let promise = new P((accept, reject) => { resolve = accept });
  return { promise, resolve };
}

"use strict";

/* Caching is tricky, and so deserves explanation.
 *
 * The general principles are thus: if we have it in cache, serve it up, even
 * if it's stale. If there's stale data in the cache, update it for future
 * requests. Don't hammer the backend if it's stale. We only have to fetch it
 * once.
 */
var P = require('bluebird');

var bole = require('bole');
var logger = bole("background-refresh-cache");
var debug = require('debuglog')('background-refresh-cache');
var EventEmitter = require('events');

var pool = require('@npmcorp/redis-pool');

/**
 * name: the cache name, for namespacing redis keys
 * fn: the function to cache
 * ttl: the cache time in seconds
 */
class Cache extends EventEmitter {
  constructor(name, fn, ttl) {
    super();
    this.pending = {};
    this.fn = fn;
    this.name = name;
    this.ttl = ttl;
  }

  get(key) {
    const cacheKey = this.name + ":" + key;
    return pool.withConnection(redis => {
      debug("checking for %j in cache", key);
      return redis.getAsync(cacheKey).then(JSON.parse)
    }).then(cached => {
      if (!cached) {
        debug("%j is not in cache, fetching", key);
        return this.fetch(key);
      } else if (!cached.fetchedAt) {
        debug("%j is not data set by this version of background-refresh-cache, re-fetching", key);
        return this.fetch(key);
      } else {
        debug("%j is in cache.", key);
        cached.fetchedFromCacheAt = Date.now();

        var freshAfter = Date.now() - this.ttl * 1000;
        if (cached.fetchedAt < freshAfter) {
          debug("Freshening %j because content fetched at %j is older than %j", key, cached.fetchedAt, freshAfter);
          this.fetch(key).catch(err => {
            if (err.statusCode == 404) {
              debug("Deleting %j from cache", key);
              return pool.withConnection(redis => {
                return redis.delAsync(cacheKey);
              });
            } else {
              throw err;
            }
          }).catch(err => logger.error(err))
        }

        return cached.value;
      }
    });

  }

  fetch(key) {
    const cacheKey = this.name + ":" + String(key);
    if (!this.pending[key]) {
      debug("no request for %j is pending, starting one", key);
      this.pending[key] = P.resolve(this.fn(key)).finally(() => {
        debug("Removing pending request for %j", key);
        delete this.pending[key]
      }).tap(value => {
        return pool.withConnection(function(redis) {
          debug("Got fresh content for %j, storing to cache", key);
          return redis.setAsync(cacheKey, JSON.stringify({
            fetchedAt: Date.now(),
             value
          }));
        }).then(() => {
          debug("Content for %j is now in cache", key);
        }).catch(err => {
          debug("Error %j", err.message);
          logger.error(err);
          return value;
        });
      });
      this.emit('fetch', this.pending[key]);
    } else {
      debug("Request for %j is already pending", key);
    }

    return this.pending[key];
  }
}

module.exports = Cache;

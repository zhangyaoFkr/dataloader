/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// A Function, which when given an Array of keys, returns a Promise of an Array
// of values or Errors.
export type BatchLoadFn<K, V> =
  (keys: $ReadOnlyArray<K>) => Promise<$ReadOnlyArray<V | Error>>;

// Optionally turn off batching or caching or provide a cache key function or a
// custom cache instance.
export type Options<K, V> = {
  batch?: boolean;
  maxBatchSize?: number;
  cache?: boolean;
  cacheKeyFn?: (key: any) => any;
  cacheMap?: CacheMap<K, Promise<V>>;
};

// If a custom cache is provided, it must be of this type (a subset of ES6 Map).
export type CacheMap<K, V> = {
  get(key: K): V | void;
  set(key: K, value: V): any;
  delete(key: K): any;
  clear(): any;
};

/**
 * A `DataLoader` creates a public API for loading data from a particular
 * data back-end with unique keys such as the `id` column of a SQL table or
 * document name in a MongoDB database, given a batch loading function.
 *
 * Each `DataLoader` instance contains a unique memoized cache. Use caution when
 * used in long-lived applications or those which serve many users with
 * different access permissions and consider creating a new instance per
 * web request.
 */
class DataLoader<K, V> {
  constructor(
    // batchLoadFn 接受 keys[], return Promise[]
    batchLoadFn: BatchLoadFn<K, V>,
    options?: Options<K, V>
  ) {
    if (typeof batchLoadFn !== 'function') {
      throw new TypeError(
        'DataLoader must be constructed with a function which accepts ' +
        `Array<key> and returns Promise<Array<value>>, but got: ${batchLoadFn}.`
      );
    }
    this._batchLoadFn = batchLoadFn;
    this._options = options;
    // 获取存储对象
    this._promiseCache = getValidCacheMap(options);
    this._queue = [];
  }

  // Private
  _batchLoadFn: BatchLoadFn<K, V>;
  _options: ?Options<K, V>;
  _promiseCache: CacheMap<K, Promise<V>>;
  _queue: LoaderQueue<K, V>;

  /**
   * Loads a key, returning a `Promise` for the value represented by that key.
   */
  load(key: K): Promise<V> {
    if (key === null || key === undefined) {
      throw new TypeError(
        'The loader.load() function must be called with a value,' +
        `but got: ${String(key)}.`
      );
    }

    // Determine options
    var options = this._options;
    var shouldBatch = !options || options.batch !== false;
    var shouldCache = !options || options.cache !== false;
    var cacheKeyFn = options && options.cacheKeyFn;
    // 可以使用 cacheKeyFn 自定义 cacheKey
    // 比如当你的 key 是一个对象你想用其中的某个字段时 || 你想把 key 做些处理
    var cacheKey = cacheKeyFn ? cacheKeyFn(key) : key;

    // If caching and there is a cache-hit, return cached Promise.
    // 如果可以使用缓存
    if (shouldCache) {
      // 使用 catchKey 获取缓存
      var cachedPromise = this._promiseCache.get(cacheKey);
      // 如果有缓存的 value 返回该 value: Promise
      if (cachedPromise) {
        return cachedPromise;
      }
    }

    // Otherwise, produce a new Promise for this value.
    // 如果没有缓存, 把这个 value 用 Promise 包装起来
    var promise = new Promise((resolve, reject) => {
      // Enqueue this Promise to be dispatched.
      // 把要获取的 key 和 Promise 的 resolve & reject 方法放入 queue 中
      // 通过 batchLoadFn & key 就可以获取到该 key 对应的方法, 然后返回给上层
      // 当 queue 中的 Promise resolve | reject 时 就会调用 load().then 继续执行
      this._queue.push({ key, resolve, reject });
      // Determine if a dispatch of this queue should be scheduled.
      // A single dispatch should be scheduled per queue at the time when the
      // queue changes from "empty" to "full".
      // 这里我的理解是 当调用了 load 方法, 这里必然长度是 1, 而 dispatchQueue 会把当前的 queue 消化掉 (queue 中可能有多个)
      // 但是 load 肯定是一个一个执行的
      // 所以如果开启了批处理, 在一个时钟周期 (事件循环) 内加入 queue 的都会被处理, 从而达到了 '批' 的目的
      if (this._queue.length === 1) {
        // 在 node 的下一个时钟周期 nextTick (setImmediate | setTimeout) 去把队里中的东西处理
        if (shouldBatch) {
          // If batching, schedule a task to dispatch the queue.
          enqueuePostPromiseJob(() => dispatchQueue(this));
        } else {
          // Otherwise dispatch the (queue of one) immediately.
          // 因为 node 是单线程的, 所以来一个触发一次, 不会积累到 queue 中
          dispatchQueue(this);
        }
      }
    });

    // If caching, cache this promise.
    // 如果允许缓存, 则缓存, 下次再用同样的 cacheKey 就可以 get 到了
    if (shouldCache) {
      this._promiseCache.set(cacheKey, promise);
    }

    return promise;
  }

  /**
   * Loads multiple keys, promising an array of values:
   *
   *     var [ a, b ] = await myLoader.loadMany([ 'a', 'b' ]);
   *
   * This is equivalent to the more verbose:
   *
   *     var [ a, b ] = await Promise.all([
   *       myLoader.load('a'),
   *       myLoader.load('b')
   *     ]);
   *
   */
  loadMany(keys: $ReadOnlyArray<K>): Promise<Array<V>> {
    if (!Array.isArray(keys)) {
      throw new TypeError(
        'The loader.loadMany() function must be called with Array<key> ' +
        `but got: ${keys}.`
      );
    }
    return Promise.all(keys.map(key => this.load(key)));
  }

  /**
   * Clears the value at `key` from the cache, if it exists. Returns itself for
   * method chaining.
   */
  clear(key: K): DataLoader<K, V> {
    var cacheKeyFn = this._options && this._options.cacheKeyFn;
    var cacheKey = cacheKeyFn ? cacheKeyFn(key) : key;
    this._promiseCache.delete(cacheKey);
    return this;
  }

  /**
   * Clears the entire cache. To be used when some event results in unknown
   * invalidations across this particular `DataLoader`. Returns itself for
   * method chaining.
   */
  clearAll(): DataLoader<K, V> {
    this._promiseCache.clear();
    return this;
  }

  /**
   * Adds the provided key and value to the cache. If the key already
   * exists, no change is made. Returns itself for method chaining.
   */
  prime(key: K, value: V): DataLoader<K, V> {
    var cacheKeyFn = this._options && this._options.cacheKeyFn;
    var cacheKey = cacheKeyFn ? cacheKeyFn(key) : key;

    // Only add the key if it does not already exist.
    // 不会改变 key 已经存在的值
    if (this._promiseCache.get(cacheKey) === undefined) {
      // Cache a rejected promise if the value is an Error, in order to match
      // the behavior of load(key).
      var promise = value instanceof Error ?
        Promise.reject(value) :
        Promise.resolve(value);

      this._promiseCache.set(cacheKey, promise);
    }

    return this;
  }
}

// Private: Enqueue a Job to be executed after all "PromiseJobs" Jobs.
//
// ES6 JavaScript uses the concepts Job and JobQueue to schedule work to occur
// after the current execution context has completed:
// http://www.ecma-international.org/ecma-262/6.0/#sec-jobs-and-job-queues
//
// Node.js uses the `process.nextTick` mechanism to implement the concept of a
// Job, maintaining a global FIFO JobQueue for all Jobs, which is flushed after
// the current call stack ends.
//
// When calling `then` on a Promise, it enqueues a Job on a specific
// "PromiseJobs" JobQueue which is flushed in Node as a single Job on the
// global JobQueue.
//
// DataLoader batches all loads which occur in a single frame of execution, but
// should include in the batch all loads which occur during the flushing of the
// "PromiseJobs" JobQueue after that same execution frame.
//
// In order to avoid the DataLoader dispatch Job occuring before "PromiseJobs",
// A Promise Job is created with the sole purpose of enqueuing a global Job,
// ensuring that it always occurs after "PromiseJobs" ends.
//
// Node.js's job queue is unique. Browsers do not have an equivalent mechanism
// for enqueuing a job to be performed after promise microtasks and before the
// next macrotask. For browser environments, a macrotask is used (via
// setImmediate or setTimeout) at a potential performance penalty.
var enqueuePostPromiseJob =
  typeof process === 'object' && typeof process.nextTick === 'function' ?
    function (fn) {
      if (!resolvedPromise) {
        resolvedPromise = Promise.resolve();
      }
      resolvedPromise.then(() => process.nextTick(fn));
    } :
    setImmediate || setTimeout;

// Private: cached resolved Promise instance
var resolvedPromise;

// Private: given the current state of a Loader instance, perform a batch load
// from its current queue.
function dispatchQueue<K, V>(loader: DataLoader<K, V>) {
  // Take the current loader queue, replacing it with an empty queue.
  var queue = loader._queue;
  // 清空 loader 的 queue
  loader._queue = [];

  // If a maxBatchSize was provided and the queue is longer, then segment the
  // queue into multiple batches, otherwise treat the queue as a single batch.
  // maxBatchSize 限制每次处理的个数, 一次只处理一段, 超出的就不要了
  var maxBatchSize = loader._options && loader._options.maxBatchSize;
  if (maxBatchSize && maxBatchSize > 0 && maxBatchSize < queue.length) {
    for (var i = 0; i < queue.length / maxBatchSize; i++) {
      dispatchQueueBatch(
        loader,
        queue.slice(i * maxBatchSize, (i + 1) * maxBatchSize)
      );
    }
  } else {
    // 如果 maxBatchSize 大于 queue 的长度, 就直接都处理了
    dispatchQueueBatch(loader, queue);
  }
}

function dispatchQueueBatch<K, V>(
  loader: DataLoader<K, V>,
  queue: LoaderQueue<K, V>
) {
  // Collect all keys to be loaded in this dispatch
  var keys = queue.map(({ key }) => key);

  // Call the provided batchLoadFn for this loader with the loader queue's keys.
  var batchLoadFn = loader._batchLoadFn;
  var batchPromise = batchLoadFn(keys);

  // Assert the expected response from batchLoadFn
  if (!batchPromise || typeof batchPromise.then !== 'function') {
    return failedDispatch(loader, queue, new TypeError(
      'DataLoader must be constructed with a function which accepts ' +
      'Array<key> and returns Promise<Array<value>>, but the function did ' +
      `not return a Promise: ${String(batchPromise)}.`
    ));
  }

  // Await the resolution of the call to batchLoadFn.
  batchPromise.then(values => {

    // Assert the expected resolution from batchLoadFn.
    if (!Array.isArray(values)) {
      throw new TypeError(
        'DataLoader must be constructed with a function which accepts ' +
        'Array<key> and returns Promise<Array<value>>, but the function did ' +
        `not return a Promise of an Array: ${String(values)}.`
      );
    }
    if (values.length !== keys.length) {
      throw new TypeError(
        'DataLoader must be constructed with a function which accepts ' +
        'Array<key> and returns Promise<Array<value>>, but the function did ' +
        'not return a Promise of an Array of the same length as the Array ' +
        'of keys.' +
        `\n\nKeys:\n${String(keys)}` +
        `\n\nValues:\n${String(values)}`
      );
    }

    // Step through the values, resolving or rejecting each Promise in the
    // loaded queue.
    queue.forEach(({ resolve, reject }, index) => {
      var value = values[index];
      if (value instanceof Error) {
        reject(value);
      } else {
        resolve(value);
      }
    });
  }).catch(error => failedDispatch(loader, queue, error));
}

// Private: do not cache individual loads if the entire batch dispatch fails,
// but still reject each request so they do not hang.
function failedDispatch<K, V>(
  loader: DataLoader<K, V>,
  queue: LoaderQueue<K, V>,
  error: Error
) {
  queue.forEach(({ key, reject }) => {
    loader.clear(key);
    reject(error);
  });
}

// Private: given the DataLoader's options, produce a CacheMap to be used.
function getValidCacheMap<K, V>(
  options: ?Options<K, V>
): CacheMap<K, Promise<V>> {
  var cacheMap = options && options.cacheMap;
  // 如果没有配置自定义的 cacheMap 则使用 Map 对象 
  if (!cacheMap) {
    return new Map();
  }
  // 检测传入的 cacheMap 对象是否具有下面这几个方法
  // 并提示缺了什么方法
  var cacheFunctions = [ 'get', 'set', 'delete', 'clear' ];
  var missingFunctions = cacheFunctions
    .filter(fnName => cacheMap && typeof cacheMap[fnName] !== 'function');
  if (missingFunctions.length !== 0) {
    throw new TypeError(
      'Custom cacheMap missing methods: ' + missingFunctions.join(', ')
    );
  }
  // 如果上面 throw error 了, 就不会走到这里
  return cacheMap;
}

// Private
type LoaderQueue<K, V> = Array<{
  key: K;
  resolve: (value: V) => void;
  reject: (error: Error) => void;
}>;

module.exports = DataLoader;

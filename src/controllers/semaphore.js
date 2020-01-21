/**
 * @module Semaphore
 */
'use strict';

class Semaphore {
  /**
   * @constructor
   * @param {number} [value=1]
   */
  constructor (value = 1) {
    this._value = ((isFinite(value) && value > 0) || value === Infinity) ? value : 1;
    this._count = 0;
    this._queue = [];
  }

  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.blocking=true]
   * @param {number} [opts.timeout=Infinity]
   * @return {Promise<boolean>}
   */
  async acquire (opts = {blocking: true, timeout: Infinity}) {
    if (Object(opts).blocking === false) {
      if (this._count === this._value) {
        return false;
      }

      this._count += 1;
      return true;
    }

    if (this._count < this._value) {
      this._count += 1;
      return true;
    }

    let isAllowed = await new Promise((resolve) => {
      let deferred = {timeoutId: null, resolve: resolve};
      this._queue.push(deferred);

      let timeout = Object(opts).timeout;
      if (isFinite(timeout) && timeout > -1) {
        deferred.timeoutId = setTimeout(() => {
          let idx = this._queue.indexOf(deferred);
          if (idx !== -1) {
            this._queue.splice(idx, 1);
          }

          resolve(false);
        }, timeout);
      }
    });

    if (isAllowed) {
      this._count += 1;
    }

    return isAllowed;
  }

  /**
   */
  release () {
    if (this._count === 0) {
      return;
    }

    this._count -= 1;
    if (this._queue.length > 0) {
      let deferred = this._queue.shift();
      clearTimeout(deferred.timeoutId);
      deferred.resolve(true);
    }
  }

  /**
   * @param {function} fn
   * @param {Object} [opts]
   * @param {boolean} [opts.blocking=true]
   * @param {number} [opts.timeout=Infinity]
   * @return {Promise<[boolean, *]>}
   */
  async withLock (fn, opts = {blocking: true, timeout: Infinity}) {
    let isAcquired = await this.acquire(opts);
    if (!isAcquired) {
      return [false];
    }

    try {
      return [true, await fn()];
    } finally {
      this.release();
    }
  }
}

module.exports = Semaphore;
/**
 * @module CV
 */
'use strict';

class CV {
  /**
   * @constructor
   */
  constructor () {
    this._count = 0;
    this._queue = [];
  }

  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.blocking=true]
   * @param {number} [opts.timeout=Infinity]
   * @return {Promise<boolean>}
   */
  async wait (semaphore, opts = {timeout: Infinity}) {
    semaphore.release();
    this._count++;
    await new Promise((resolve) => {
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
    await semaphore.acquire();
  }

  /**
   */
  signal () {
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

  broadcast() {
    while(this.count > 0) {
      this.signal();
    }
  }
}

module.exports = CV;
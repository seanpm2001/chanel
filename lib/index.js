var co = require('co')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits

inherits(Channel, EventEmitter)

module.exports = Channel

function Channel(options) {
  if (!(this instanceof Channel))
    return new Channel(options)

  options = options || {}

  EventEmitter.call(this, options)

  this.concurrency = options.concurrency || Infinity
  // closed by default
  this.closed = !(options.closed === false || options.open)
  this.discard = options.discard

  this.fns = []
  this.results = []

  this.fnIndex = 0
  this.resultIndex = 0
  this.pending = 0
  this.errors = 0

  this.reading = true
}

Object.defineProperty(Channel.prototype, 'pushable', {
  get: function () {
    return this.reading && this.pending < this.concurrency
  }
})

// read queue
Object.defineProperty(Channel.prototype, 'queue', {
  get: function () {
    var queue = this.results.length + this.fns.length
    if (this.discard) queue += this.pending
    return queue
  }
})

// you can read from a channel if there's a read queue or if this channel is not closed
Object.defineProperty(Channel.prototype, 'readable', {
  get: function () {
    return this.queue || !this.closed
  }
})

Channel.prototype.open = function () {
  this.closed = false
  return this
}

Channel.prototype.close = function () {
  this.closed = true
  return this
}

/**
 * Push a function to the channel.
 * If `null`, just means closing the channel.
 */

Channel.prototype.push = function (fn) {
  if (fn == null) return this.close()

  if (typeof fn !== 'function')
    throw new TypeError('you may only push functions')

  this.fns.push(fn)
  if (!this.discard) this.results.length++
  this.call()
return this
}

Channel.prototype.call = function () {
  if (!this.pushable) return
  if (!this.fns.length) return

  var fn = this.fns.shift()
  var index = this.fnIndex++
  this.pending++

  var self = this
  fn(function (err, res) {
    self.pending--
    if (err) {
      self.reading = false
      self.errors++
      if (self.discard) {
        self.results.push(err)
      } else {
        self.results[index - self.resultIndex] = err
      }
    } else if (!self.discard) {
      self.results[index - self.resultIndex] = arguments.length > 2
        ? [].slice.call(arguments, 1)
        : res
    }

    self.emit(String(index))
    self.emit('callback')
    self.call()
  })
}

Channel.prototype.read = function* () {
  var self = this
  // continue executing callbacks if no errors occured
  if (!this.reading && !this.errors) this.reading = true

  if (!self.discard) {
    if (self.results.length && 0 in self.results) {
      var res = self.results.shift()
      self.resultIndex++
      if (res instanceof Error) {
        self.errors--
        throw res
      }
      return res
    }
  } else if (self.results.length) {
    // these can only be errors
    self.errors--
    throw self.results.shift()
  }

  // wait for the next result in the queue
  return yield function (done) {
    self.once(self.discard ?  'callback' : String(self.resultIndex), function () {
      if (!self.discard) {
        var res = self.results.shift()
        self.resultIndex++
        if (res instanceof Error) {
          self.errors--
          done(res)
        } else {
          done(null, res)
        }
      } else if (self.results.length) {
        // these can only be errors
        self.errors--
        done(self.results.shift())
      } else {
        done()
      }
    })
  }
}

Channel.prototype.flush = function* () {
  if (this.discard) {
    while (this.readable) yield* this.read()
    return
  }

  var results = []
  while (this.readable) results.push(yield* this.read())
  return results
}

// for non-generator peeps
Channel.prototype.end = co(Channel.prototype.flush)
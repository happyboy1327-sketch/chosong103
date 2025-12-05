var Writable = require('stream').Writable

//create function which automatically calls write callback
//after delegating the item to the action
var writeSync = function(action) {
  return function(obj, enc, cb) {
    action(obj)
    cb()
  }
}

//create a function which expects action to call the callback
var writeAsync = function(action) {
  return function(obj, enc, cb) {
    action(obj, enc, cb)
  }
}

module.exports = function(opts, cb) {
  if(typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  var action = cb.length == 1 ? writeSync(cb) : writeAsync(cb)
  var writable = new Writable(opts)
  writable._write = action
  return writable
}

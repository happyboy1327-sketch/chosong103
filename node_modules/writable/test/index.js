var writable = require('../')

describe('async writer', function() {
  it('works', function(done) {
    var writer = writable(function(item, enc, cb) {
      if(item == 'done') {
        done()
      }
      cb()
    })
    writer.write('sup!')
    writer.write('done')
  })
})

describe('sync writer', function() {
  it('works', function(done) {
    var writer = writable(function(item) {
      if(item == 'done') done();
    })
    writer.write('hit')
    writer.write('done')
  })
})

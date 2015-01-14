'use strict';
var assert = require('assert'),
    cb = require('assert-called'),
    session = require('express-session'),
    FoundationDb = require('fdb').apiVersion(300),
    FoundationStore = require('..')(session);

require('longjohn');

describe('connect-foundationdb', function () {

    var mydb, fs, range;

    this.timeout(10000);

    var eat = function (done, fn) {
        return function (e, data) {
            try {
                assert.ifError(e);
                fn(data);
            } catch (x) {
                done(x);
            }
        }
    };

    // Cleanup any existing collection
    before(function (done) {
        mydb = FoundationDb.open();
        FoundationDb.directory.removeIfExists(mydb, 'test-sessions')(function before(e) {
            console.log('Completed test setup.');
            done(e);
        });
    });

    it('should create the FDBStore', function createStore(done) {
        fs = new FoundationStore({
            directory: 'test-sessions',
            hash: {}
        });
        fs.on('connected', cb(function (e) {
            FoundationDb.directory.open(mydb, 'test-sessions')(eat(done, function (d) {
                assert(d, 'Should have a test-sessions directory.');
                range = d.range();
                done();
            }));
        }))
    });

    it('should have a 0 count', function count0session(done) {
       fs.length(eat(done, function (l) {
           assert.equal(l, 0);
           done();
       }));
    });

    it('should add a session', function addSession(done) {
        fs.set('thisisatest', {foo: 1, bar: 2, baz: {str: 'keystr', val: new Buffer([0, 1, 2, 3, 4, 5])}},
            eat(done, function () {
                mydb.doTransaction(function (tr, commit) {
                    tr.getRange(range.begin, range.end).toArray(function (e, u) {
                        assert(u && u.length !== 0, 'Should have a sessions.');
                        done(e);
                    });
                    commit();
                })();
            }));
    });

    it('should have a 1 count', function count0session(done) {
        fs.length(eat(done, function (l) {
            assert.equal(l, 1);
            done();
        }));
    });

    it('should not find a non-existent session', function nonExistent(done) {
        fs.get('this is not a test', eat(done, function (s) {
            assert(!s, 'Session should not be found');
            done();
        }));
    });

    it('should get a session', function findSession(done) {
        fs.get('thisisatest', eat(done, function (s) {
            assert(s, 'Session should be found');
            assert.equal(s.foo, 1, 'mismatched session value');
            assert.equal(s.bar, 2, 'mismatched session value');
            assert.equal(s.baz.str, 'keystr', 'mismatched session value');
            assert.equal(new Buffer(s.baz.val).toString('hex'), '000102030405', 'mismatch session value buffer');
            done();
        }));
    });

    it('should clear the store', function clearStore(done) {
        fs.clear(function (e) {
            assert.ifError(e);
            mydb.doTransaction(function (tr, commit) {
                tr.getRange(range.begin, range.end).toArray(function (e, u) {
                    assert(!u || u.length === 0, 'Should not have any sessions.');
                    done(e);
                });
                commit();
            })();
        });
    });

    it('should have a 0 count again', function count0session(done) {
        fs.length(eat(done, function (l) {
            assert.equal(l, 0);
            done();
        }));
    });

    it('should add a session after clearing', function addSession(done) {
        fs.set('thisisatest2', {foo: 1, bar: 2},
            eat(done, function () {
                mydb.doTransaction(function (tr, commit) {
                    tr.getRange(range.begin, range.end).toArray(function (e, u) {
                        assert(u && u.length !== 0, 'Should have a sessions.');
                        done(e);
                    });
                    commit();
                })();
            }));
    });

    it('should destroy a session', function destroySession(done) {
        fs.destroy('thisisatest2', eat(done, function () {
           done();
        }));
    });

    after(function cleanup(done) {
        fs.clear(done);
    });
});
/*!
 * connect-foundationdb
 * Copyright(c) 2015 Max Metral <opensource@pyralis.com>
 * MIT Licensed
 */

var crypto = require('crypto');
var util = require('util');
var FoundationDb = require('fdb').apiVersion(300);

var debug = require('debuglog')('connect-foundationdb');

var noop = function () {
};

/**
 * Default options
 */
var defaultOptions = {
    directory: 'sessions',
    defaultExpirationTime: 1000 * 60 * 60 * 24 * 14 // 14 days
};

function defaultSerializer(session) {
    // Copy each property of the session to a new object
    var obj = {};
    for (var prop in session) {
        if (prop === 'cookie') {

            // Convert the cookie instance to an object, if possible
            // This gets rid of the duplicate object under session.cookie.data property

            obj.cookie = session.cookie.toJSON ? session.cookie.toJSON() : session.cookie;
        } else {
            obj[prop] = session[prop];
        }
    }

    return obj;
}

function identity(x) {
    return x;
}

module.exports = function (connect) {
    var Store = connect.Store || connect.session.Store;

    function FDBStore(options) {
        options = options || {};
        var directory = options.directory || defaultOptions.directory;

        Store.call(this, options);

        // Hash sid
        if (options.hash) {
            var defaultSalt = 'connect-foundationdb';
            var defaultAlgorithm = 'sha1';
            this.hash = {};
            this.hash.salt = options.hash.salt ? options.hash.salt : defaultSalt;
            this.hash.algorithm = options.hash.algorithm ? options.hash.algorithm : defaultAlgorithm;
        }

        // Serialization
        if (options.stringify || (!('stringify' in options) && !('serialize' in options) && !('unserialize' in options))) {
            this.serializeSession = JSON.stringify;
            this.unserializeSession = JSON.parse;
        } else {
            this.serializeSession = options.serialize || defaultSerializer;
            this.unserializeSession = options.unserialize || identity;
        }

        // Expiration time
        this.defaultExpirationTime = options.defaultExpirationTime || defaultOptions.defaultExpirationTime;
        this.snapshotReads = (options.snapshotReads === true);

        var self = this;

        function changeState(newState) {
            debug('switched to state: %s', newState);
            self.state = newState;
            self.emit(newState);
        }

        function connectionReady(err) {
            if (err) {
                debug('not able to connect to the database');
                changeState('disconnected');
                throw err;
            }
            changeState('connected');
        }

        this.fdb = options.fdb || FoundationDb.open(options.clusterFile);

        changeState('init');
        FoundationDb.directory.createOrOpen(this.fdb, directory)(function (err, dir) {
            self.dir = dir;
            connectionReady(err);
        });
        changeState('connecting');
    }

    /**
     * Inherit from `Store`.
     */
    util.inherits(FDBStore, Store);

    /**
     * Attempt to fetch session by the given `sid`.
     *
     * @param {String} sid
     * @param {Function} callback
     * @api public
     */

    FDBStore.prototype.get = function (sid, callback) {
        if (!callback) callback = noop;
        sid = this.hash ? crypto.createHash(this.hash.algorithm).update(this.hash.salt + sid).digest('hex') : sid;
        var self = this;

        var session;
        this.fdb.doTransaction(function (tr, commit) {
            var whichRead = self.snapshotReads ? tr.snapshot : tr;
            whichRead.get(self.dir.pack(['data', sid]), function (err, sdoc) {
                session = sdoc;
                commit(err);
            });
        })(function (err) {
            if (err) {
                debug('not able to execute `find` query for session: %s', sid);
                return callback(err);
            }
            try {
                if (session) {
                    try {
                        session = JSON.parse(session);
                    } catch (parseException) {
                        debug('session failed to parse: %s', sid);
                        return callback(parseException);
                    }
                    if (!session.expires || Date.now() < session.expires) {
                        var s;
                        try {
                            s = self.unserializeSession(session.session);
                        } catch (err) {
                            debug('unable to deserialize session');
                            return callback(err);
                        }
                        callback(null, s);
                    } else {
                        debug('destroying expired session');
                        self.destroy(sid, callback);
                    }
                } else {
                    debug('not able to find session: %s', sid);
                    return callback();
                }
            } catch (x) {
                debug('exception finding session %s: %s', sid, x.message);
                throw x;
            }
        });
    };

    /**
     * Commit the given `sess` object associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} callback
     * @api public
     */

    FDBStore.prototype.set = function (sid, session, callback) {
        if (!callback) callback = noop;
        sid = this.hash ? crypto.createHash(this.hash.algorithm).update(this.hash.salt + sid).digest('hex') : sid;
        var s;
        try {
            s = {_id: sid, session: this.serializeSession(session)};
        } catch (err) {
            debug('unable to serialize session');
            callback(err);
        }

        if (session && session.cookie && session.cookie.expires) {
            s.expires = new Date(session.cookie.expires).getTime();
        } else {
            // If there's no expiration date specified, it is
            // browser-session cookie or there is no cookie at all,
            // as per the connect docs.
            //
            // So we set the expiration to two-weeks from now
            // - as is common practice in the industry (e.g Django) -
            // or the default specified in the options.
            var today = new Date();
            s.expires = today.getTime() + this.defaultExpirationTime;
        }

        var self = this, content = JSON.stringify(s);
        this.fdb.doTransaction(function (tr, commit) {
            tr.set(self.dir.pack(['data', sid]), content);
            commit();
        })(function (err) {
            if (err) debug('not able to set/update session: ' + sid);
            callback(err);
        });
    };

    /**
     * Destroy the session associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Function} callback
     * @api public
     */

    FDBStore.prototype.destroy = function (sid, callback) {
        var self = this;
        if (!callback) callback = noop;
        sid = this.hash ? crypto.createHash(this.hash.algorithm).update(this.hash.salt + sid).digest('hex') : sid;
        this.fdb.doTransaction(function (tr, commit) {
            tr.clear(self.dir.pack(['data', sid]));
            commit();
        })(function (err) {
            if (err) debug('Not able to clear session: ' + sid);
            callback(err);
        });
    };

    /**
     * Fetch number of sessions.
     *
     * @param {Function} callback
     * @api public
     */

    FDBStore.prototype.length = function (callback) {
        if (!callback) callback = noop;
        // Right now there's no good way to get a count in FDB without fetching them all, which is nuts.
        // Storing a counter is also problematic because it's unclear whether a key was inserted or not
        // when we set it (right?)
        var self = this;
        this.fdb.doTransaction(function (tr, commit) {
            var whichRead = self.snapshotReads ? tr.snapshot : tr;
            var range = self.dir.range();
            whichRead.getRange(range.begin, range.end).toArray(function (err, arr) {
                callback(err, arr ? arr.length : 0);
            });
            commit();
        });
    };

    /**
     * Clear all sessions.
     *
     * @param {Function} callback
     * @api public
     */

    FDBStore.prototype.clear = function (callback) {
        if (!callback) callback = noop;

        var range = this.dir.range();
        this.fdb.clearRange(range.begin, range.end)(function (err) {
            if (err) {
                debug('Could not clear sessions: %s', err.message);
            } else {
                debug('Cleared session directory');
            }
            callback(err);
        });
    };

    return FDBStore;
};
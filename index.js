/*!
 * connect-foundationdb
 * Copyright(c) 2015 Max Metral <opensource@pyralis.com>
 * MIT Licensed
 */

var crypto = require('crypto');
var util = require('util');
var FoundationDb = require('fdb').apiVersion(300);
var debug = require('debuglog')('connect-foundationdb');

var BSON;

try {
    var bson = require('bson');
    try {
        var native = bson.native(),
            Long = native.Long,
            ObjectID = native.ObjectID,
            Binary = native.Binary,
            Code = native.Code,
            DBRef = native.DBRef,
            Symbol = native.Symbol,
            Double = native.Double,
            Timestamp = native.Timestamp,
            MaxKey = native.MaxKey,
            MinKey = native.MinKey;

        BSON = new (native.BSON)([Long, ObjectID, Binary, Code, DBRef, Symbol, Double, Timestamp, MaxKey, MinKey]);
        debug('Using native BSON parser.');
    } catch (ignored) {
        BSON = bson.BSONPure.BSON;
        debug('Using Javascript BSON parser.');
    }
} catch (ignored) {
    debug('Using JSON parser.');
}

function sessionToFDBValue(s) {
    if (BSON) {
        return BSON.serialize(s, false, true, false);
    }
    return JSON.stringify(s);
}
function sessionFromFDBValue(buffer) {
    if (BSON) {
        return BSON.deserialize(buffer);
    }
    return JSON.parse(buffer);
}

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

function intToBuffer(intVal) {
    var value = new Buffer(4);
    value.writeInt32LE(intVal,0);
    return value;
}

function bufferToInt(buffer) {
    return buffer.readInt32LE(0);
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
            var defaultAlgorithm = 'sha256';
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
            self.countKey = dir.pack(['count']);
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
            tr.get(self.dir.pack(['data', sid]), function (err, sdoc) {
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
                        session = sessionFromFDBValue(session);
                    } catch (parseException) {
                        debug('session failed to parse: %s', sid);
                        return callback(parseException);
                    }
                    if (!session.expires || Date.now() < session.expires) {
                        var s;
                        try {
                            s = self.unserializeSession(session.session);
                        } catch (unserializeError) {
                            debug('unable to deserialize session');
                            return callback(unserializeError);
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

        var self = this, sessionRecordKey = this.dir.pack(['data', sid]),
            content = sessionToFDBValue(s);
        this.fdb.doTransaction(function (tr, commit) {
            tr.get(sessionRecordKey, function (readErr, existingSession) {
                if (readErr) {
                    return commit(readErr);
                }
                if (!existingSession) {
                    tr.add(self.countKey, intToBuffer(1));
                }
                tr.set(sessionRecordKey, content);
                commit();
            });
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
        var sessionRecordKey = this.dir.pack(['data', sid]);
        this.fdb.doTransaction(function (tr, commit) {
            tr.get(sessionRecordKey, function (readErr, existingSession) {
                if (readErr) {
                    return commit(readErr);
                }
                if (existingSession) {
                    tr.add(self.countKey, intToBuffer(-1));
                }
                tr.clear(sessionRecordKey);
                commit();
            });
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
        var self = this, sessionCount = 0;
        // We maintain the count separately. I bet there are some crazy conditions
        // that could cause this to be off by some small number. The cleanup
        // script (that isn't written yet) should take this into account
        this.fdb.doTransaction(function (tr, commit) {
            tr.get(self.countKey, function (readError, count) {
                if (readError) {
                    return commit(readError);
                }
                if (count) {
                    sessionCount = bufferToInt(count);
                }
                commit();
            });
        }, function (e) {
            callback(e, sessionCount);
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

        var self = this, range = this.dir.range();
        this.fdb.doTransaction(function (tr, commit) {
            tr.clearRange(range.begin, range.end);
            tr.clear(self.countKey);
            commit();
        }, function (err) {
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
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

        this.fdb = FoundationDb.open(options.clusterFile);

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
            whichRead.getKey(self.dir.pack(['data', sid]), function (err, sdoc) {
                session = sdoc;
            });
            commit();
        })(function (err) {
            if (err) {
                debug('not able to execute `find` query for session: ' + sid);
                return callback(err);
            }
            if (session) {
                try {
                    session = JSON.parse(session);
                } catch (parseException) {
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
                    self.destroy(sid, callback);
                }
            } else {
                debug('not able to find session: %s', sid);
                return callback();
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
            s.expires = new Date(session.cookie.expires);
        } else {
            // If there's no expiration date specified, it is
            // browser-session cookie or there is no cookie at all,
            // as per the connect docs.
            //
            // So we set the expiration to two-weeks from now
            // - as is common practice in the industry (e.g Django) -
            // or the default specified in the options.
            var today = new Date();
            s.expires = new Date(today.getTime() + this.defaultExpirationTime);
        }

        var self = this;
        this.fdb.doTransaction(function (tr, commit) {
            tr.set(self.dir.pack(['data', sid]), JSON.stringify(s));
            commit();
        })(function (err) {
            if (err) debug('not able to set/update session: ' + sid);
            callback(err);
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

        debug('cleared session directory');
        FoundationDb.directory.removeIfExists(this.fdb, this.dir.getPath())(callback);
    };

    return FDBStore;
};
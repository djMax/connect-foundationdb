# connect-foundationdb
[![Build Status](https://travis-ci.org/djMax/connect-foundationdb.png)](https://travis-ci.org/djMax/connect-foundationdb)

FoundationDb session store for [Connect](https://github.com/senchalabs/connect) and [Express](http://expressjs.com/)
based on [connect-mongo](https://github.com/kcbanner/connect-mongo)

## Compatibility

* Support Express `4.x`, `5.0` and Connect `3.x` through [express-session](https://github.com/expressjs/session)
* Support Express `2.x`, `3.x` and Connect `>= 1.0.3`, `2.x`
* Support [foundation db driver](https://www.npmjs.com/package/fdb) `>= 300`
* Support Node.js `0.10` and `0.11` (maybe)

## Usage

### Express or Connect integration

Express `4.x`, `5.0` and Connect `3.x`:

```js
var session = require('express-session');
var FoundationStore = require('connect-foundationdb')(session);

app.use(session({
    secret: 'foo',
    store: new FoundationStore(options)
}));
```

Express `2.x`, `3.x` and Connect `1.x`, `2.x`:

```js
var FoundationStore = require('connect-foundationdb')(express);

app.use(express.session({
    secret: 'foo',
    store: new FoundationStore(options)
}));
```

For Connect `1.x` and `2.x`, just replace `express` by `connect`.

### Connection to FoundationDB

In many circumstances, `connect-foundationdb` will not be the only part of your application which need a connection to a FoundationDb database. You can re-use the existing connection.

Alternatively, you can configure `connect-foundationdb` to establish a new connection, or just leave both blank
and let the default behavior of fdb.open() just work.

#### Re-use a FoundationDB connection

```js
var fdb = require('fdb');

var mydb = fdb.open(connectionOptions);

app.use(session({
    store: new FoundationStore({ fdb: mydb })
}));
```

#### Create a new connection from a FoundationDB cluster file

```js
// Basic usage
app.use(session({
    store: new FoundationStore({ clusterFile: 'whatever.fdb' })
}));
```

## More options

  - `directory` FoundationDB directory to use (optional, default: `sessions`)
  - `stringify` If true, connect-foundationdb will serialize sessions using `JSON.stringify` before
                setting them, and deserialize them with `JSON.parse` when getting them.
                (optional, default: true). This is useful if you are using types that
                MongoDB doesn't support.
  - `serialize` Custom hook for serializing sessions to FDB. This is helpful if you need
                to modify the session before writing it out.
  - `unserialize` Custom hook for unserializing sessions from FDB. This can be used in
                scenarios where you need to support different types of serializations
                (e.g., objects and JSON strings) or need to modify the session before using
                it in your app.
  - `hash` (optional) Hash is an object, which will determine whether hash the sid in foundationdb, if it's not undefined, the sid will be hashed
  - `hash.salt` Salt will be used to hash the sid in foundationdb, default salt is "connect-foundationdb"
  - `hash.algorithm` Hash algorithm, default algorithm is "sha1"

## Removing expired sessions

  **Note:** By connect/express's default, session cookies are set to
  expire when the user closes their browser (maxAge: null). In accordance
  with standard industry practices, connect-foundationdb will set these sessions
  to expire two weeks from their last 'set'. You can override this
  behavior by manually setting the maxAge for your cookies.
  
  **More Note:** currently nothing reclaims sessions other than an attempt
  to access an expired session. We'll need to add some periodic reclamation
  because I don't think fdb has an "expiration" concept. This will also require
  maintaining an index on last access or some such.

## Tests

You need `mocha` and FoundationDB installed and running locally.

The tests use an FDB directory called `test-sessions`.

## License

(The MIT License)

Copyright (c) 2015 Max Metral &lt;opensource@pyralis.com&gt;

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


/**
 * Module requirements.
 */

var Transport = require('../transport')
  , parser = require('engine.io-parser')
  , zlib = require('zlib')
  , accepts = require('accepts')
  , debug = require('debug')('engine:polling');

var compressionMethods = {
  gzip: zlib.createGzip,
  deflate: zlib.createDeflate
};

/**
 * Exports the constructor.
 */

module.exports = Polling;

/**
 * HTTP polling constructor.
 *
 * @api public.
 */

function Polling (req) {
  Transport.call(this, req);
}

/**
 * Inherits from Transport.
 *
 * @api public.
 */

Polling.prototype.__proto__ = Transport.prototype;

/**
 * Transport name
 *
 * @api public
 */

Polling.prototype.name = 'polling';

/**
 * Overrides onRequest.
 *
 * @param {http.ServerRequest}
 * @api private
 */

Polling.prototype.onRequest = function (req) {
  var res = req.res;

  if ('GET' == req.method) {
    this.onPollRequest(req, res);
  } else if ('POST' == req.method) {
    this.onDataRequest(req, res);
  } else {
    res.writeHead(500);
    res.end();
  }
};

/**
 * The client sends a request awaiting for us to send data.
 *
 * @api private
 */

Polling.prototype.onPollRequest = function (req, res) {
  if (this.req) {
    debug('request overlap');
    // assert: this.res, '.req and .res should be (un)set together'
    this.onError('overlap from client');
    res.writeHead(500);
    return;
  }

  debug('setting request');

  this.req = req;
  this.res = res;

  var self = this;

  function onClose () {
    self.onError('poll connection closed prematurely');
  }

  function cleanup () {
    req.removeListener('close', onClose);
    self.req = self.res = null;
  }

  req.cleanup = cleanup;
  req.on('close', onClose);

  this.writable = true;
  this.emit('drain');

  // if we're still writable but had a pending close, trigger an empty send
  if (this.writable && this.shouldClose) {
    debug('triggering empty send to append close packet');
    this.send([{ type: 'noop', options: { compress: true } }]);
  }
};

/**
 * The client sends a request with data.
 *
 * @api private
 */

Polling.prototype.onDataRequest = function (req, res) {
  if (this.dataReq) {
    // assert: this.dataRes, '.dataReq and .dataRes should be (un)set together'
    this.onError('data request overlap from client');
    res.writeHead(500);
    return;
  }

  var isBinary = 'application/octet-stream' == req.headers['content-type'];

  this.dataReq = req;
  this.dataRes = res;

  var chunks = isBinary ? new Buffer(0) : '';
  var self = this;

  function cleanup () {
    chunks = isBinary ? new Buffer(0) : '';
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('close', onClose);
    self.dataReq = self.dataRes = null;
  }

  function onClose () {
    cleanup();
    self.onError('data request connection closed prematurely');
  }

  function onData (data) {
    var contentLength;
    if (typeof data == 'string') {
      chunks += data;
      contentLength = Buffer.byteLength(chunks);
    } else {
      chunks = Buffer.concat([chunks, data]);
      contentLength = chunks.length;
    }

    if (contentLength > self.maxHttpBufferSize) {
      chunks = '';
      req.connection.destroy();
    }
  }

  function onEnd () {
    self.onData(chunks);

    var headers = {
      // text/html is required instead of text/plain to avoid an
      // unwanted download dialog on certain user-agents (GH-43)
      'Content-Type': 'text/html',
      'Content-Length': 2
    };

    // prevent XSS warnings on IE
    // https://github.com/LearnBoost/socket.io/pull/1333
    var ua = req.headers['user-agent'];
    if (ua && (~ua.indexOf(';MSIE') || ~ua.indexOf('Trident/'))) {
      headers['X-XSS-Protection'] = '0';
    }

    res.writeHead(200, self.headers(req, headers));
    res.end('ok');
    cleanup();
  }

  req.on('close', onClose);
  req.on('data', onData);
  req.on('end', onEnd);
  if (!isBinary) req.setEncoding('utf8');
};

/**
 * Processes the incoming data payload.
 *
 * @param {String} encoded payload
 * @api private
 */

Polling.prototype.onData = function (data) {
  debug('received "%s"', data);
  var self = this;
  var callback = function(packet) {
    if ('close' == packet.type) {
      debug('got xhr close packet');
      self.onClose();
      return false;
    }

    self.onPacket(packet);
  };

  parser.decodePayload(data, callback);
};

/**
 * Overrides onClose.
 *
 * @api private
 */

Polling.prototype.onClose = function () {
  if (this.writable) {
    // close pending poll request
    this.send([{ type: 'noop', options: { compress: true } }]);
  }
  Transport.prototype.onClose.call(this);
};

/**
 * Writes a packet payload.
 *
 * @param {Object} packet
 * @api private
 */

Polling.prototype.send = function (packets) {
  this.writable = false;

  if (this.shouldClose) {
    debug('appending close packet to payload');
    packets.push({ type: 'close', options: { compress: true } });
    this.shouldClose();
    this.shouldClose = null;
  }

  var self = this;
  parser.encodePayload(packets, this.supportsBinary, function(data) {
    var compress = packets.some(function(packet) {
      return packet.options && packet.options.compress;
    });
    self.write(data, { compress: compress });
  });
};

/**
 * Writes data as response to poll request.
 *
 * @param {String} data
 * @param {Object} options
 * @api private
 */

Polling.prototype.write = function (data, options) {
  debug('writing "%s"', data);
  var self = this;
  this.doWrite(data, options, function() {
    self.req.cleanup();
  });
};

/**
 * Performs the write.
 *
 * @api private
 */

Polling.prototype.doWrite = function (data, options, callback) {
  var self = this;

  // explicit UTF-8 is required for pages not served under utf
  var isString = typeof data == 'string';
  var contentType = isString
    ? 'text/plain; charset=UTF-8'
    : 'application/octet-stream';

  var headers = {
    'Content-Type': contentType
  };

  // prevent XSS warnings on IE
  // https://github.com/LearnBoost/socket.io/pull/1333
  var ua = this.req.headers['user-agent'];
  if (ua && (~ua.indexOf(';MSIE') || ~ua.indexOf('Trident/'))) {
    headers['X-XSS-Protection'] = '0';
  }

  if (!this.httpCompression || !options.compress) {
    respond(data);
    return;
  }

  var len = isString ? Buffer.byteLength(data) : data.length;
  if (len < this.httpCompression.threshold) {
    respond(data);
    return;
  }

  var encoding = accepts(this.req).encodings(['gzip', 'deflate']);
  if (!encoding) {
    respond(data);
    return;
  }

  this.compress(data, encoding, function(err, data) {
    if (err) {
      self.res.writeHead(500);
      self.res.end();
      callback(err);
      return;
    }

    headers['Content-Encoding'] = encoding;
    respond(data);
  });

  function respond(data) {
    headers['Content-Length'] = 'string' == typeof data ? Buffer.byteLength(data) : data.length;
    self.res.writeHead(200, self.headers(self.req, headers));
    self.res.end(data);
    callback();
  }
};

/**
 * Comparesses data.
 *
 * @api private
 */

Polling.prototype.compress = function (data, encoding, callback) {
  debug('compressing');

  var buffers = [];
  var nread = 0;

  compressionMethods[encoding](this.httpCompression)
    .on('error', callback)
    .on('data', function(chunk) {
      buffers.push(chunk);
      nread += chunk.length;
    })
    .on('end', function() {
      callback(null, Buffer.concat(buffers, nread));
    })
    .end(data);
};

/**
 * Closes the transport.
 *
 * @api private
 */

Polling.prototype.doClose = function (fn) {
  debug('closing');

  if (this.dataReq) {
    debug('aborting ongoing data request');
    this.dataReq.destroy();
  }

  if (this.writable) {
    debug('transport writable - closing right away');
    this.send([{ type: 'close', options: { compress: true } }]);
    fn();
  } else {
    debug('transport not writable - buffering orderly close');
    this.shouldClose = fn;
  }
};

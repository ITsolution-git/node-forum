"use strict";

var	SocketIO = require('socket.io'),
	socketioWildcard = require('socketio-wildcard')(),
	util = require('util'),
	async = require('async'),
	path = require('path'),
	fs = require('fs'),
	nconf = require('nconf'),
	cookieParser = require('cookie-parser')(nconf.get('secret')),
	winston = require('winston'),

	db = require('../database'),
	user = require('../user'),
	topics = require('../topics'),
	logger = require('../logger'),
	ratelimit = require('../middleware/ratelimit'),

	Sockets = {},
	Namespaces = {};

/* === */


var io;

Sockets.init = function(server) {
	var config = {
		transports: ['polling', 'websocket'],
		path: nconf.get('relative_path') + '/socket.io'
	};

	io = new SocketIO();

	addRedisAdapter(io);

	io.use(socketioWildcard);

	io.listen(server, config);

	Sockets.server = io;

	fs.readdir(__dirname, function(err, files) {
		files.splice(files.indexOf('index.js'), 1);

		async.each(files, function(lib, next) {
			if (lib.substr(lib.length - 3) === '.js') {
				lib = lib.slice(0, -3);
				Namespaces[lib] = require('./' + lib);
			}

			next();
		});
	});

	io.use(function(socket, next) {
		console.log('AUTH');

		var handshake = socket.request,
		 	sessionID;

		if (!handshake) {
		 	return next(new Error('[[error:not-authorized]]'));
		}

		cookieParser(handshake, {}, function(err) {
			if (err) {
				return next(err);
			}

			var sessionID = handshake.signedCookies['express.sid'];

			db.sessionStore.get(sessionID, function(err, sessionData) {
				if (err) {
					return next(err);
				}
				if (sessionData && sessionData.passport && sessionData.passport.user) {
					socket.uid = parseInt(sessionData.passport.user, 10);
				} else {
					socket.uid = 0;
				}
				next();
			});
		});
	});

	io.on('connection', function(socket) {
		console.log('CONNECTED', socket.uid, socket.id);

		socket.ip = socket.request.connection.remoteAddress;

		logger.io_one(socket, socket.uid);

		if (socket.uid) {
			socket.join('uid_' + socket.uid);
			socket.join('online_users');

			async.parallel({
				user: function(next) {
					user.getUserFields(socket.uid, ['username', 'userslug', 'picture', 'status'], next);
				},
				isAdmin: function(next) {
					user.isAdministrator(socket.uid, next);
				}
			}, function(err, userData) {
				if (err || !userData.user) {
					return;
				}
				socket.emit('event:connect', {
					status: 1,
					username: userData.user.username,
					userslug: userData.user.userslug,
					picture: userData.user.picture,
					isAdmin: userData.isAdmin,
					uid: socket.uid
				});

				socket.broadcast.emit('event:user_status_change', {uid: socket.uid, status: userData.user.status});
			});
		} else {
			socket.join('online_guests');
			socket.emit('event:connect', {
				status: 1,
				username: '[[global:guest]]',
				isAdmin: false,
				uid: 0
			});
		}

		socket.on('disconnect', function() {
			var socketCount = Sockets.getUserSocketCount(socket.uid);
			console.log('DISCONNECT', socket.uid, socket.id);
			if (socket.uid && socketCount <= 0) {
				socket.broadcast.emit('event:user_status_change', {uid: socket.uid, status: 'offline'});
			}

			// for(var roomName in io.sockets.manager.roomClients[socket.id]) {
			// 	if (roomName.indexOf('topic') !== -1) {
			// 		io.sockets.in(roomName.slice(1)).emit('event:user_leave', socket.uid);
			// 	}
			// }
		});

		socket.on('*', function(payload) {
			if (!payload.data.length) {
				return winston.warn('[socket.io] Empty payload');
			}

			var eventName = payload.data[0];
			var params = payload.data[1];
			var callback = typeof payload.data[payload.data.length - 1] === 'function' ? payload.data[payload.data.length - 1] : function() {};

			if (!eventName) {
				return winston.warn('[socket.io] Empty method name');
			}

			if (ratelimit.isFlooding(socket)) {
				winston.warn('[socket.io] Too many emits! Disconnecting uid : ' + socket.uid + '. Message : ' + payload.name);
				return socket.disconnect();
			}

			var parts = eventName.toString().split('.'),
				namespace = parts[0],
				methodToCall = parts.reduce(function(prev, cur) {
					if (prev !== null && prev[cur]) {
						return prev[cur];
					} else {
						return null;
					}
				}, Namespaces);

			if(!methodToCall) {
				if (process.env.NODE_ENV === 'development') {
					winston.warn('[socket.io] Unrecognized message: ' + eventName);
				}
				return;
			}

			if (Namespaces[namespace].before) {
				Namespaces[namespace].before(socket, eventName, function() {
					callMethod(methodToCall, socket, params, callback);
				});
			} else {
				callMethod(methodToCall, socket, params, callback);
			}
		});
	});
};

function addRedisAdapter(io) {
	if (nconf.get('redis')) {
		var redisAdapter = require('socket.io-redis');
		var redis = require('../database/redis');
		var pub = redis.connect({return_buffers: true});
		var sub = redis.connect({return_buffers: true});

		io.adapter(redisAdapter({pubClient: pub, subClient: sub}));
	} else {
		winston.warn('[socket.io] Clustering detected, you are advised to configure Redis as a websocket store.');
	}
}

function callMethod(method, socket, params, callback) {
	method.call(null, socket, params, function(err, result) {
		callback(err ? {message: err.message} : null, result);
	});
}

Sockets.logoutUser = function(uid) {
	Sockets.getUserSockets(uid).forEach(function(socket) {
		if (socket.handshake && socket.handshake.signedCookies && socket.handshake.signedCookies['express.sid']) {
			db.sessionStore.destroy(socket.handshake.signedCookies['express.sid']);
		}

		socket.emit('event:disconnect');
		socket.disconnect();
	});
};

Sockets.in = function(room) {
	return io.sockets.in(room);
};

Sockets.getSocketCount = function() {
	// TODO: io.sockets.adapter.sids is local to this worker
	// use redis-adapter

	var clients = Object.keys(io.sockets.adapter.sids || {});
	return Array.isArray(clients) ? clients.length : 0;
};

Sockets.getUserSocketCount = function(uid) {
	// TODO: io.sockets.adapter.sids is local to this worker
	// use .clients('uid_' + uid, fn)

	var roomClients = Object.keys(io.sockets.adapter.rooms['uid_' + uid] || {});
	return Array.isArray(roomClients) ? roomClients.length : 0;
};

Sockets.getOnlineAnonCount = function () {
	// TODO: io.sockets.adapter.rooms is local to this worker
	// use .clients()

	var guestSocketIds = Object.keys(io.sockets.adapter.rooms.online_guests || {});
	return Array.isArray(guestSocketIds) ? guestSocketIds.length : 0;
};

Sockets.getUserSockets = function(uid) {
	// TODO: doesn't work in cluster

	var userSocketIds = Object.keys(io.sockets.adapter.rooms['uid_' + uid] || {});
	if (!Array.isArray(userSocketIds) || !userSocketIds.length) {
		return [];
	}
	uid = parseInt(uid, 10);

	var sockets = [];
	userSocketIds.forEach(function(sid) {
		if (io.sockets.connected[sid] && io.sockets.connected[sid].uid === uid) {
			sockets.push(io.sockets.connected[sid])	;
		}
	});

	return sockets;
};

Sockets.getUserRooms = function(uid) {
	// TODO:
	// io.sockets.adapter.rooms is local to this worker
	// io.sockets.adapter.sids is local to this worker
	// use .clients('uid_' + uid, fn)
	// user .roomClients(socketId, fn)

	var rooms = {};

	if (!io.sockets.adapter.rooms['uid_' + uid]) {
		return [];
	}
	var uidSocketIds = Object.keys(io.sockets.adapter.rooms['uid_' + uid]);
	if (!Array.isArray(uidSocketIds)) {
		return [];
	}
	for (var i=0; i<uidSocketIds.length; ++i) {
		var roomClients = io.sockets.adapter.sids[uidSocketIds[i]];
	 	for (var roomName in roomClients) {
	 		if (roomName && roomClients.hasOwnProperty(roomName)) {
	 			rooms[roomName] = true;
	 		}
	 	}
	}

	rooms = Object.keys(rooms);
	return rooms;
};

Sockets.reqFromSocket = function(socket) {
	var headers = socket.request.headers,
	  	host = headers.host,
	  	referer = headers.referer || '';

	return {
	 	ip: socket.ip,
	 	host: host,
	 	protocol: socket.request.connection.encrypted ? 'https' : 'http',
	 	secure: !!socket.request.connection.encrypted,
	 	url: referer,
	 	path: referer.substr(referer.indexOf(host) + host.length),
	 	headers: headers
	 };
};

Sockets.isUserOnline = function(uid) {
	// TODO: io.sockets.adapter.rooms is local to this worker
	// use .clients('uid_' + uid, fn)
	return io ? !!io.sockets.adapter.rooms['uid_' + uid] : false;
};

Sockets.isUsersOnline = function(uids, callback) {
	callback(null, uids.map(Sockets.isUserOnline));
};

Sockets.updateRoomBrowsingText = function (roomName, selfUid) {
	if (!roomName) {
		return;
	}

	var	uids = Sockets.getUidsInRoom(roomName);
	var total = uids.length;
	uids = uids.slice(0, 9);
	if (selfUid) {
		uids = [selfUid].concat(uids);
	}
	if (!uids.length) {
		return;
	}
	user.getMultipleUserFields(uids, ['uid', 'username', 'userslug', 'picture', 'status'], function(err, users) {
		if (err) {
			return;
		}

		users = users.filter(function(user) {
			return user && user.status !== 'offline';
		});

		io.sockets.in(roomName).emit('event:update_users_in_room', {
			users: users,
			room: roomName,
			total: Math.max(0, total - uids.length)
		});
	});
};

Sockets.getUidsInRoom = function(roomName) {
	// TODO : doesnt work in cluster

	var uids = [];

	var socketids = Object.keys(io.sockets.adapter.rooms[roomName] || {});
	if (!Array.isArray(socketids) || !socketids.length) {
		return [];
	}

	for(var i=0; i<socketids.length; ++i) {
		var socketRooms = Object.keys(io.sockets.adapter.sids[socketids[i]]);
		if (Array.isArray(socketRooms)) {
			socketRooms.forEach(function(roomName) {
				if (roomName.indexOf('uid_') === 0 ) {
					uids.push(roomName.split('_')[1]);
				}
			});
		}
	}

	return uids;
};


/* Exporting */
module.exports = Sockets;

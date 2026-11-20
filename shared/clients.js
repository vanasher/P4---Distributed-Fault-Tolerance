// gRPC clients for the service nodes. Used by the view node (its model layer) and by any service
// node that needs another node (the schedule node calls the course node).
const { grpc, proto, ADDR } = require('./common');

// Short reconnect backoff so a restarted node is picked up within ~2s instead of up to 2 minutes.
// Channels connect lazily, so a process only opens connections to the nodes it actually calls.
const options = { 'grpc.initial_reconnect_backoff_ms': 500, 'grpc.max_reconnect_backoff_ms': 2000 };
const creds = grpc.credentials.createInsecure();
const clients = {
  auth: new proto.Auth(ADDR.auth, creds, options),
  course: new proto.Course(ADDR.course, creds, options),
  grade: new proto.Grade(ADDR.grade, creds, options),
  announcement: new proto.Announcement(ADDR.announcement, creds, options),
  schedule: new proto.Schedule(ADDR.schedule, creds, options),
};

const downMessage = (service) => `The ${service} service is down right now. Other features still work.`;

// Circuit breaker: services whose node was unreachable on the last call. While a service is marked down,
// calls fail instantly instead of each waiting out the deadline (a stopped container's IP doesn't refuse
// connections, it just never answers). The channel keeps reconnecting in the background, and the first
// call after it is READY again closes the breaker.
const down = new Set();

// Calls one RPC with a deadline. A down node fails fast with UNAVAILABLE instead of hanging the caller.
function call(service, method, request, token, ms = 2000) {
  const client = clients[service];
  if (down.has(service)) {
    const state = client.getChannel().getConnectivityState(true); // true = keep trying to connect
    if (state !== grpc.connectivityState.READY) {
      return Promise.reject({ code: grpc.status.UNAVAILABLE, details: downMessage(service), down: true });
    }
    down.delete(service);
  }

  const metadata = new grpc.Metadata();
  if (token) metadata.set('authorization', token);
  return new Promise((resolve, reject) => {
    client[method](request, metadata, { deadline: Date.now() + ms }, (err, reply) => {
      if (!err) return resolve(reply);
      err.down = err.code === grpc.status.UNAVAILABLE || err.code === grpc.status.DEADLINE_EXCEEDED;
      // The node itself is unreachable (vs. the node answering that its database is unavailable).
      if (err.down && !/database/i.test(err.details || '')) {
        err.details = downMessage(service);
        down.add(service);
      }
      reject(err);
    });
  });
}

module.exports = { call, grpc };

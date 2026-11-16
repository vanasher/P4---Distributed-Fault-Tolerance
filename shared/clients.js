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

// Calls one RPC with a deadline. A down node fails fast with UNAVAILABLE instead of hanging the caller.
function call(service, method, request, token, ms = 2000) {
  const metadata = new grpc.Metadata();
  if (token) metadata.set('authorization', token);
  return new Promise((resolve, reject) => {
    clients[service][method](request, metadata, { deadline: Date.now() + ms }, (err, reply) => {
      if (!err) return resolve(reply);
      err.down = err.code === grpc.status.UNAVAILABLE || err.code === grpc.status.DEADLINE_EXCEEDED;
      if (err.down) err.details = `The ${service} service is down right now. Other features still work.`;
      reject(err);
    });
  });
}

module.exports = { call, grpc };

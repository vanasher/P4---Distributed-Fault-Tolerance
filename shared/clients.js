// Model layer of the view node: gRPC clients for the service nodes.
const { grpc, proto, ADDR } = require('../shared/common');

// Short reconnect backoff so a restarted node is picked up within ~2s instead of up to 2 minutes.
const options = { 'grpc.initial_reconnect_backoff_ms': 500, 'grpc.max_reconnect_backoff_ms': 2000 };
const creds = grpc.credentials.createInsecure();
const clients = {
  auth: new proto.Auth(ADDR.auth, creds, options),
  course: new proto.Course(ADDR.course, creds, options),
  grade: new proto.Grade(ADDR.grade, creds, options),
};

// Calls one RPC with a 2s deadline. A down node fails fast with UNAVAILABLE instead of hanging the page.
function call(service, method, request, token) {
  const metadata = new grpc.Metadata();
  if (token) metadata.set('authorization', token);
  return new Promise((resolve, reject) => {
    clients[service][method](request, metadata, { deadline: Date.now() + 2000 }, (err, reply) => {
      if (!err) return resolve(reply);
      if (err.code === grpc.status.UNAVAILABLE || err.code === grpc.status.DEADLINE_EXCEEDED)
        err.details = `The ${service} service is down right now. Other features still work.`;
      reject(err);
    });
  });
}

module.exports = { call, grpc };

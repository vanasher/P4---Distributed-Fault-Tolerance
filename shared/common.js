// Code shared by every node: proto loading, addresses, JWT checks, DB opening, gRPC server setup.
const fs = require('node:fs');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const jwt = require('jsonwebtoken');

const proto = grpc.loadPackageDefinition(
  loader.loadSync(path.join(__dirname, '..', 'proto', 'enrollment.proto'), { keepCase: true, defaults: true })
).enrollment;

// All nodes must share this secret so each one can verify tokens on its own.
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Where each service node lives. Override with env vars to run nodes on different machines.
const ADDR = {
  auth: process.env.AUTH_ADDR || 'localhost:50051',
  course: process.env.COURSE_ADDR || 'localhost:50052',
  grade: process.env.GRADE_ADDR || 'localhost:50053',
};

function fail(code, details) {
  throw { code: grpc.status[code], details };
}

// Verifies the JWT locally (no call to the auth node), so a dead auth node does not log everyone out.
// ponytail: logout is not checked here, a logged-out token stays valid on other nodes until it expires (1h).
// Add a revocation list pushed from the auth node if that matters.
function requireUser(call, role) {
  let user;
  try {
    user = jwt.verify(String(call.metadata.get('authorization')[0] || ''), SECRET);
  } catch {
    fail('UNAUTHENTICATED', 'Please log in again.');
  }
  if (role && user.role !== role) fail('PERMISSION_DENIED', `Only ${role} accounts can do that.`);
  return user;
}

function openDb(file, schema) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, file));
  db.exec(schema);
  return db;
}

// Starts a gRPC server for one service. Handlers are plain functions that return the reply or throw via fail().
function serve(name, handlers) {
  const impl = {};
  for (const [method, fn] of Object.entries(handlers)) {
    impl[method] = (call, cb) => {
      try {
        cb(null, fn(call));
        console.log(`${new Date().toISOString()} ${name}.${method} ok`);
      } catch (e) {
        const err = e.code !== undefined ? e : { code: grpc.status.INTERNAL, details: String(e.message) };
        console.log(`${new Date().toISOString()} ${name}.${method} failed: ${err.details}`);
        cb(err);
      }
    };
  }
  const server = new grpc.Server();
  server.addService(proto[name].service, impl);
  const port = ADDR[name.toLowerCase()].split(':').pop();
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) throw err;
    console.log(`${name} node listening on port ${port}`);
  });
}

module.exports = { grpc, proto, SECRET, ADDR, fail, requireUser, openDb, serve };

// Code shared by every node: proto loading, addresses, JWT checks, DB pool, gRPC server setup.
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const jwt = require('jsonwebtoken');
const { Pool, Client } = require('pg');

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
  announcement: process.env.ANNOUNCEMENT_ADDR || 'localhost:50054',
  schedule: process.env.SCHEDULE_ADDR || 'localhost:50055',
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

// PostgreSQL: one shared server, one database per service (database-per-service pattern).
const PG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'p4',
  password: process.env.PGPASSWORD || 'p4',
};
let pool; // this process's connection pool (one per service node)

// Opens this service's connection pool, creating its database and tables on first start.
// Retries for ~30s so a service can start before PostgreSQL is ready.
async function openDb(name, schema) {
  const database = (process.env.DB_PREFIX || '') + name;
  for (let attempt = 1; ; attempt++) {
    const admin = new Client({ ...PG, database: 'postgres', connectionTimeoutMillis: 2000 });
    try {
      await admin.connect();
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      if (!rowCount) await admin.query(`CREATE DATABASE "${database}"`);
      break;
    } catch (e) {
      if (e.code === '42P04') break; // created by someone else in the meantime
      if (attempt >= 30) throw e;
      console.log(`Waiting for PostgreSQL at ${PG.host}:${PG.port} (${e.message})`);
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      await admin.end().catch(() => {});
    }
  }

  // Connection pool: up to DB_POOL_MAX connections are opened once and reused across requests,
  // instead of paying a TCP + auth handshake per query. A dead DB fails within 1s, inside the view's 2s deadline.
  pool = new Pool({
    ...PG,
    database,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 1000,
  });
  pool.on('error', (e) => console.log(`Idle DB connection dropped: ${e.message}`)); // e.g. DB restarted; pool reconnects on next use
  await pool.query(schema);
  console.log(`Connected to database "${database}" on ${PG.host}:${PG.port} (pool max ${pool.options.max})`);
  return pool;
}

// Runs fn(client) inside a transaction on one pooled connection; commits, or rolls back on any error.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Maps any thrown error to a gRPC status. Lost DB connectivity becomes UNAVAILABLE, not a raw driver message.
function toGrpcError(e) {
  if (typeof e.code === 'number') return { code: e.code, details: e.details };
  const dbDown = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|timeout exceeded when trying to connect|Connection terminated|terminating connection/i;
  if (dbDown.test(e.message) || /^(08|57P)/.test(e.code || '')) return { code: grpc.status.UNAVAILABLE, details: 'The database is unavailable right now.' };
  return { code: grpc.status.INTERNAL, details: String(e.message) };
}

// Starts a gRPC server for one service. Handlers return the reply (or a promise of it) or throw via fail().
function serve(name, handlers) {
  const impl = {};
  for (const [method, fn] of Object.entries(handlers)) {
    impl[method] = (call, cb) => {
      const stats = () => (pool ? ` [pool: ${pool.totalCount} open, ${pool.idleCount} idle, ${pool.waitingCount} waiting]` : '');
      Promise.resolve()
        .then(() => fn(call))
        .then((reply) => {
          console.log(`${new Date().toISOString()} ${name}.${method} ok${stats()}`);
          cb(null, reply);
        })
        .catch((e) => {
          const err = toGrpcError(e);
          console.log(`${new Date().toISOString()} ${name}.${method} failed: ${err.details}${stats()}`);
          cb(err);
        });
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

// Runs a service's async startup; exits with the error if it fails (e.g. PostgreSQL never came up).
function main(fn) {
  fn().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { grpc, proto, SECRET, ADDR, fail, requireUser, openDb, transaction, serve, main };

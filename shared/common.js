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

// Input rules shared by the view (early, friendly check) and the services (the real check: any gRPC
// client can call a service directly, so a service never trusts that the view checked first).
const RULES = {
  username: /^[A-Za-z0-9_.-]{1,32}$/,
  course: /^[A-Z0-9-]{2,12}$/, // after toUpperCase()
  passwordMax: 128,
};

// PostgreSQL: one shared server, one database per service (database-per-service pattern).
const PG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5433), // host port of the db container; 5433 avoids clashing with a locally installed PostgreSQL
  user: process.env.PGUSER || 'p4',
  password: process.env.PGPASSWORD || 'p4',
};
let pool; // this process's connection pool (one per service node)

const revoked = new Set();

function requireUser(call, role) {
  let user;
  try {
    user = jwt.verify(String(call.metadata.get('authorization')[0] || ''), SECRET, { algorithms: ['HS256'] });
  } catch {
    fail('UNAUTHENTICATED', 'Please log in again.');
  }
  if (revoked.has(user.jti)) fail('UNAUTHENTICATED', 'Please log in again.');
  if (role && user.role !== role) fail('PERMISSION_DENIED', `Only ${role} accounts can do that.`);
  return user;
}

// Every non-auth node pulls the revoked-session list from Auth. If Auth is down, keep the last known list.
function syncRevocations(self) {
  const { call } = require('./clients'); // lazy: clients.js itself requires this file
  const tick = async () => {
    try {
      const token = jwt.sign({ sub: self, role: 'service' }, SECRET, { expiresIn: '1m' });
      const { jti } = await call('auth', 'ListRevoked', {}, token, 1000);
      revoked.clear();
      jti.forEach((j) => revoked.add(j));
    } catch {
      // Auth node down: keep the last known list and try again on the next tick.
    } finally {
      // Schedule the next tick only after this one ends, so slow calls never pile up.
      setTimeout(tick, Number(process.env.REVOKE_POLL_MS || 5000)).unref();
    }
  };
  tick();
}

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
  // Unexpected error: the full error goes to this node's log only. The caller gets no SQL or stack details.
  console.error(e);
  return { code: grpc.status.INTERNAL, details: 'Something went wrong. Please try again.' };
}

// Starts a gRPC server for one service. Handlers return the reply (or a promise of it) or throw via fail().
function serve(name, handlers) {
  if (name !== 'Auth')
    syncRevocations(name); // only non-auth nodes need to pull the revocation list from Auth
  
  const impl = {};
  for (const [method, fn] of Object.entries(handlers)) {
    impl[method] = async (call, cb) => {
      const started = Date.now();
      let reply = null;
      let err = null;
      try {
        reply = await fn(call);
      } catch (e) {
        err = toGrpcError(e);
      } finally {
        // One log line per request, success or failure, with the time taken and the pool state.
        const stats = pool ? ` [pool: ${pool.totalCount} open, ${pool.idleCount} idle, ${pool.waitingCount} waiting]` : '';
        const outcome = err ? `failed: ${err.details}` : 'ok';
        console.log(`${new Date().toISOString()} ${name}.${method} ${outcome} (${Date.now() - started} ms)${stats}`);
      }
      cb(err, reply);
    };
  }
  const server = new grpc.Server();
  server.addService(proto[name].service, impl);
  const port = ADDR[name.toLowerCase()].split(':').pop();
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) {
      console.error(`${name} node cannot listen on port ${port}: ${err.message} (is another copy already running?)`);
      process.exit(1);
    }
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

module.exports = { grpc, proto, SECRET, ADDR, RULES, fail, requireUser, openDb, transaction, serve, main };

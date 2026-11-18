// Auth node: checks passwords, issues JWTs, tracks sessions.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { SECRET, fail, requireUser, openDb, serve, main } = require('../shared/common');

const hash = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');

main(async () => {
  const db = await openDb('auth', `
    CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, created TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS revoked (jti TEXT PRIMARY KEY, expires TIMESTAMPTZ NOT NULL);
    `);

  for (const [username, role] of [['student1', 'student'], ['student2', 'student'], ['faculty1', 'faculty']]) {
    const salt = crypto.randomBytes(16).toString('hex');
    await db.query('INSERT INTO users VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [username, salt, hash('password', salt), role]);
  }

  serve('Auth', {
    async Login({ request: { username, password } }) {
      const { rows: [user] } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
      const ok = user && crypto.timingSafeEqual(Buffer.from(hash(password, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
      if (!ok) fail('UNAUTHENTICATED', 'Wrong username or password.');

      const id = crypto.randomUUID();
      await db.query('INSERT INTO sessions (id, username) VALUES ($1, $2)', [id, username]);
      const token = jwt.sign({ sub: username, role: user.role }, SECRET, { expiresIn: '1h', jwtid: id });
      return { token, username, role: user.role };
    },

    async Logout(call) {
      const user = requireUser(call);
      await db.query('DELETE FROM sessions WHERE id = $1', [user.jti]);
      await db.query('INSERT INTO revoked VALUES ($1, to_timestamp($2)) ON CONFLICT DO NOTHING', [user.jti, user.exp]);
      return {};
    },

    async ListRevoked(call) {
      requireUser(call, 'service');                       // only nodes holding the shared secret
      await db.query('DELETE FROM revoked WHERE expires < now()');  // token would be expired anyway
      const { rows } = await db.query('SELECT jti FROM revoked');
      return { jti: rows.map((r) => r.jti) };
    },
  });
});

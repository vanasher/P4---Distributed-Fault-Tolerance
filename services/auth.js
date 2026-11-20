// Auth node: checks passwords, issues JWTs, tracks sessions.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { SECRET, RULES, fail, requireUser, openDb, serve, main } = require('../shared/common');

const hash = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

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
    async Login({ request }) {
      const username = request.username.trim();
      const { password } = request;
      if (!username || !password) fail('INVALID_ARGUMENT', 'Enter your username and password.');
      if (!RULES.username.test(username)) fail('INVALID_ARGUMENT', 'Usernames use only letters, digits, ".", "_" and "-" (up to 32).');
      if (password.length > RULES.passwordMax) fail('INVALID_ARGUMENT', `Passwords are at most ${RULES.passwordMax} characters.`);

      const { rows: [user] } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
      // Hash even for an unknown username, so the response time does not reveal which usernames exist.
      const computed = Buffer.from(hash(password, user ? user.salt : DUMMY_SALT), 'hex');
      const ok = user && crypto.timingSafeEqual(computed, Buffer.from(user.hash, 'hex'));
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

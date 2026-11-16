// Auth node: checks passwords, issues JWTs, tracks sessions.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { SECRET, fail, requireUser, openDb, serve } = require('../shared/common');

const db = openDb('auth.db', `
  CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, salt TEXT, hash TEXT, role TEXT);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, username TEXT, created TEXT);
`);

const hash = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');

if (!db.prepare('SELECT 1 FROM users').get()) {
  const add = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)');
  for (const [username, role] of [['student1', 'student'], ['student2', 'student'], ['faculty1', 'faculty']]) {
    const salt = crypto.randomBytes(16).toString('hex');
    add.run(username, salt, hash('password', salt), role);
  }
}

serve('Auth', {
  Login({ request: { username, password } }) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = user && crypto.timingSafeEqual(Buffer.from(hash(password, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
    if (!ok) fail('UNAUTHENTICATED', 'Wrong username or password.');

    const id = crypto.randomUUID();
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(id, username, new Date().toISOString());
    const token = jwt.sign({ sub: username, role: user.role }, SECRET, { expiresIn: '1h', jwtid: id });
    return { token, username, role: user.role };
  },

  Logout(call) {
    const user = requireUser(call);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(user.jti);
    return {};
  },
});

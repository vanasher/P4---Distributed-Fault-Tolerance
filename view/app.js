// View node: Express MVC. Controllers are the routes below, models are the gRPC clients, views are the EJS files.
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { call, grpc } = require('../shared/clients');
const { SECRET, RULES } = require('../shared/common');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 20 }));
app.use(cookieParser());

// ?msg= and ?error= come from the URL, so anyone can edit them. Accept a single string only, cap its
// length, and let EJS escape it (<%= %>), so the text cannot inject HTML.
const note = (value) => (typeof value === 'string' && value ? value.slice(0, 300) : null);

app.use((req, res, next) => {
  try {
    req.user = jwt.verify(req.cookies.token, SECRET, { algorithms: ['HS256'] });
  } catch {
    req.user = null; // missing, expired, or forged cookie: treated as logged out
  }
  Object.assign(res.locals, { user: req.user, msg: note(req.query.msg), error: note(req.query.error) });
  next();
});

const loggedIn = (req, res, next) => (req.user ? next() : res.redirect('/login'));
// Form field as a string; missing body, missing field, or a repeated field (array) all become ''.
const field = (req, name) => (typeof req.body?.[name] === 'string' ? req.body[name] : '');
const clip = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s);
const back = (res, page, key, text) => res.redirect(`${page}?${key}=${encodeURIComponent(text)}`);

// Expired or rejected token goes to login; anything else (including a down node) is shown on the page.
function showError(res, err, view, data) {
  if (err.code === grpc.status.UNAUTHENTICATED) {
    res.clearCookie('token');
    return back(res, '/login', 'error', err.details);
  }
  res.render(view, { ...data, error: err.details || err.message });
}

app.get('/', (req, res) => res.redirect(req.user ? '/courses' : '/login'));

app.get('/login', (req, res) => res.render('login'));

app.post('/login', async (req, res) => {
  const username = field(req, 'username').trim();
  const password = field(req, 'password');
  if (!username || !password) return res.render('login', { error: 'Enter your username and password.' });
  if (!RULES.username.test(username) || password.length > RULES.passwordMax) {
    return res.render('login', { error: 'Wrong username or password.' }); // same text as a real mismatch
  }
  try {
    const { token } = await call('auth', 'Login', { username, password });
    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 3600 * 1000 });
    res.redirect('/courses');
  } catch (err) {
    res.render('login', { error: err.details || 'Login failed. Please try again.' });
  }
});

app.post('/logout', async (req, res) => {
  try {
    await call('auth', 'Logout', {}, req.cookies.token); // revokes the token on every node
  } catch (err) {
    console.log(`Logout could not reach the auth node: ${err.details || err.message}`);
  } finally {
    // Always log out in this browser, even when the auth node is down.
    res.clearCookie('token');
    res.redirect('/login');
  }
});

app.get('/courses', loggedIn, async (req, res) => {
  try {
    const { courses } = await call('course', 'ListCourses', {}, req.cookies.token);
    res.render('courses', { courses });
  } catch (err) {
    showError(res, err, 'courses', { courses: [] });
  }
});

app.post('/courses/:code/enroll', loggedIn, async (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  if (!RULES.course.test(code)) return back(res, '/courses', 'error', 'Invalid course code.');
  try {
    await call('course', 'Enroll', { code }, req.cookies.token);
    back(res, '/courses', 'msg', `Enrolled in ${code}.`);
  } catch (err) {
    back(res, err.code === grpc.status.UNAUTHENTICATED ? '/login' : '/courses', 'error', err.details);
  }
});

app.get('/grades', loggedIn, async (req, res) => {
  try {
    const { grades } = await call('grade', 'MyGrades', {}, req.cookies.token);
    res.render('grades', { grades });
  } catch (err) {
    showError(res, err, 'grades', { grades: [] });
  }
});

// Faculty upload: one "student,course,grade" per line; an optional header row is skipped.
// The view only splits the CSV; the grade node validates the values.
app.post('/grades', loggedIn, async (req, res) => {
  const lines = field(req, 'csv').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (/^student\s*,\s*course\s*,\s*grade$/i.test(lines[0] || '')) lines.shift();
  const bad = lines.find((line) => line.split(',').length !== 3);
  if (bad) return back(res, '/grades', 'error', `"${clip(bad)}": each line must be student,course,grade.`);
  const grades = lines.map((line) => {
    const [student, course, grade] = line.split(',');
    return { student, course, grade };
  });
  try {
    const { saved } = await call('grade', 'UploadGrades', { grades }, req.cookies.token);
    back(res, '/grades', 'msg', `Saved ${saved} grade${saved === 1 ? '' : 's'}.`);
  } catch (err) {
    back(res, err.code === grpc.status.UNAUTHENTICATED ? '/login' : '/grades', 'error', err.details);
  }
});

app.get('/announcements', loggedIn, async (req, res) => {
  try {
    const { announcements } = await call('announcement', 'ListAnnouncements', {}, req.cookies.token);
    res.render('announcements', { announcements });
  } catch (err) {
    showError(res, err, 'announcements', { announcements: [] });
  }
});

app.post('/announcements', loggedIn, async (req, res) => {
  try {
    await call('announcement', 'PostAnnouncement', { title: field(req, 'title'), body: field(req, 'body') }, req.cookies.token);
    back(res, '/announcements', 'msg', 'Announcement posted.');
  } catch (err) {
    back(res, err.code === grpc.status.UNAUTHENTICATED ? '/login' : '/announcements', 'error', err.details);
  }
});

app.get('/schedule', loggedIn, async (req, res) => {
  try {
    const { slots, note } = await call('schedule', 'MySchedule', {}, req.cookies.token);
    res.render('schedule', { slots, note });
  } catch (err) {
    showError(res, err, 'schedule', { slots: [], note: '' });
  }
});

// Last resort: never show a stack trace. Oversized form posts (>100 KB) go back with a message.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large' || err.type === 'parameters.too.many') {
    const page = ['/grades', '/announcements'].includes(req.path) ? req.path : '/login';
    const text = err.type === 'entity.too.large' ? 'That upload is too large (limit 100 KB).' : 'That form has too many fields.';
    return back(res, page, 'error', text);
  }
  console.error(err);
  res.status(500).type('text').send('Something went wrong. Please go back and try again.');
});

// HTTPS. Uses certs/cert.pem + certs/key.pem (e.g. from mkcert); creates a self-signed pair if missing.
async function tls() {
  const dir = process.env.CERT_DIR || path.join(__dirname, '..', 'certs');
  const files = { cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') };
  if (!fs.existsSync(files.cert) || !fs.existsSync(files.key)) {
    const pems = await require('selfsigned').generate([{ name: 'commonName', value: 'localhost' }], { days: 365 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(files.cert, pems.cert);
    fs.writeFileSync(files.key, pems.private);
    console.log(`Created a self-signed certificate in ${dir}`);
  }
  return { cert: fs.readFileSync(files.cert), key: fs.readFileSync(files.key) };
}

async function start() {
  const port = Number(process.env.VIEW_PORT || 3000);
  try {
    const server = https.createServer(await tls(), app);
    server.on('error', (err) => {
      console.error(`View node cannot listen on port ${port}: ${err.message} (is another copy already running?)`);
      process.exit(1);
    });
    server.listen(port, '0.0.0.0', () => console.log(`View node on https://localhost:${port}`));
  } catch (err) {
    // For example, a damaged cert.pem or key.pem. Delete the certs folder to get a new self-signed pair.
    console.error(`View node cannot start HTTPS: ${err.message}`);
    process.exit(1);
  }
}
start();

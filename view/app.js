// View node: Express MVC. Controllers are the routes below, models are the gRPC clients, views are the EJS files.
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { call, grpc } = require('./clients');
const { SECRET } = require('../shared/common');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((req, res, next) => {
  try {
    req.user = jwt.verify(req.cookies.token, SECRET);
  } catch {
    req.user = null;
  }
  Object.assign(res.locals, { user: req.user, msg: req.query.msg || null, error: req.query.error || null });
  next();
});

const loggedIn = (req, res, next) => (req.user ? next() : res.redirect('/login'));
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
  try {
    const { token } = await call('auth', 'Login', { username: req.body.username, password: req.body.password });
    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 3600 * 1000 });
    res.redirect('/courses');
  } catch (err) {
    res.render('login', { error: err.details });
  }
});

app.post('/logout', async (req, res) => {
  await call('auth', 'Logout', {}, req.cookies.token).catch(() => {}); // still log out locally if the auth node is down
  res.clearCookie('token');
  res.redirect('/login');
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
  try {
    await call('course', 'Enroll', { code: req.params.code }, req.cookies.token);
    back(res, '/courses', 'msg', `Enrolled in ${req.params.code}.`);
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

// Faculty upload: one "student,course,grade" per line.
app.post('/grades', loggedIn, async (req, res) => {
  const grades = String(req.body.csv || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [student = '', course = '', grade = ''] = line.split(',');
      return { student, course, grade };
    });
  try {
    const { saved } = await call('grade', 'UploadGrades', { grades }, req.cookies.token);
    back(res, '/grades', 'msg', `Saved ${saved} grade${saved === 1 ? '' : 's'}.`);
  } catch (err) {
    back(res, err.code === grpc.status.UNAUTHENTICATED ? '/login' : '/grades', 'error', err.details);
  }
});

// HTTPS. Uses certs/cert.pem + certs/key.pem (e.g. from mkcert); creates a self-signed pair if missing.
async function tls() {
  const dir = process.env.CERT_DIR || path.join(__dirname, '..', 'certs');
  const files = { cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') };
  if (!fs.existsSync(files.cert)) {
    const pems = await require('selfsigned').generate([{ name: 'commonName', value: 'localhost' }], { days: 365 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(files.cert, pems.cert);
    fs.writeFileSync(files.key, pems.private);
    console.log(`Created a self-signed certificate in ${dir}`);
  }
  return { cert: fs.readFileSync(files.cert), key: fs.readFileSync(files.key) };
}

const port = process.env.VIEW_PORT || 3000;
tls().then((options) =>
  https.createServer(options, app).listen(port, '0.0.0.0', () => console.log(`View node on https://localhost:${port}`))
);

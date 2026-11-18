// End-to-end check against the P4 SPECIFICATIONS. Starts all nodes on spare ports against throwaway test_* databases,
// runs the main flows, then kills and restarts nodes one by one and checks that the rest of the app keeps working.
// Every check prints PASS/FAIL with the expected and the actual result, and a summary is printed at the end.
// Needs PostgreSQL on localhost:5433 (docker compose up -d db). Run: npm test
// Debugging: TEST_VERBOSE=1 shows every node's log output. NO_COLOR=1 turns off colors.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the test's view node uses a throwaway self-signed cert

const ADDRS = {
  AUTH_ADDR: 'localhost:51051',
  COURSE_ADDR: 'localhost:51052',
  GRADE_ADDR: 'localhost:51053',
  ANNOUNCEMENT_ADDR: 'localhost:51054',
  SCHEDULE_ADDR: 'localhost:51055',
};
// Set before shared/clients is loaded, so the test's own gRPC clients point at the test nodes.
Object.assign(process.env, ADDRS);
const { call, grpc } = require('./shared/clients');

const env = {
  ...process.env,
  ...ADDRS,
  CERT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'p4-test-')),
  VIEW_PORT: '3100',
  DB_PREFIX: 'test_', // services create test_auth, test_course, ... instead of touching the real databases
  REVOKE_POLL_MS: '500', // default is 5000; a short poll keeps the logout-revocation check fast and reliable
};
const BASE = 'https://localhost:3100';
const SERVICES = ['auth', 'course', 'grade', 'announcement', 'schedule'];
const STDIO = process.env.TEST_VERBOSE ? 'inherit' : 'ignore'; // an unread pipe can fill up and block a node
const nodes = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Text report: everything printed to the terminal is also saved (without colors) to a file ----------
// Default: test-results.txt next to this file. Override with TEST_REPORT=path/to/file.txt
const REPORT = path.resolve(process.env.TEST_REPORT || path.join(__dirname, 'test-results.txt'));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
fs.writeFileSync(REPORT, `P4 test run: ${new Date().toISOString()}\n\n`);
for (const method of ['log', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(...args);
    fs.appendFileSync(REPORT, stripAnsi(util.format(...args)) + '\n');
  };
}

// ---------- Reporting: every check prints its expected and actual result ----------
const C = process.env.NO_COLOR
  ? { g: '', r: '', d: '', b: '', x: '' }
  : { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
let total = 0;
const failed = [];

const oneLine = (s, max = 160) => {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
};
// Visible text of an HTML page (no head styles, scripts, tags or the nav header).
const strip = (html) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<header>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

// What the response looked like: the text around the match if there is one, else the start of the page or the redirect.
function actualText(r, re) {
  if (typeof r === 'string') r = { body: r };
  const raw = r.location || r.body || '';
  const m = re && raw.match(re);
  if (m) return '...' + oneLine(raw.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)) + '...';
  const prefix = r.status ? `HTTP ${r.status} ` : '';
  return oneLine(prefix + (r.location ? `redirect to ${r.location}` : strip(raw)));
}

function record(label, ok, expected, actual) {
  total++;
  const n = String(total).padStart(3, '0');
  console.log(`${ok ? C.g + 'PASS' : C.r + 'FAIL'}${C.x} [${n}] ${label}`);
  console.log(`${C.d}       expected:${C.x} ${expected}`);
  console.log(`${C.d}       actual:  ${C.x} ${actual}`);
  if (!ok) failed.push(`[${n}] ${label}`);
}
const rawOf = (r) => (typeof r === 'string' ? r : r.location || r.body || '');
const expectMatch = (label, r, re) => record(label, re.test(rawOf(r)), `response matches ${re}`, actualText(r, re));
const expectNoMatch = (label, r, re) => record(label, !re.test(rawOf(r)), `response does not match ${re}`, actualText(r, re));
const expectEqual = (label, actual, expected) => record(label, actual === expected, JSON.stringify(expected), JSON.stringify(actual));
async function expectRejects(label, promise, codeName) {
  try {
    await promise;
    record(label, false, `gRPC error ${codeName}`, 'call succeeded');
  } catch (e) {
    const name = grpc.status[e.code] ?? e.code;
    record(label, name === codeName, `gRPC error ${codeName}`, `gRPC error ${name}`);
  }
}
const section = (title) => console.log(`\n${C.b}=== ${title} ===${C.x}`);

function summary() {
  const passed = total - failed.length;
  console.log(`\n${C.b}${passed}/${total} checks passed${C.x}`);
  if (failed.length) {
    console.log(`${C.r}Failed checks:${C.x}`);
    failed.forEach((f) => console.log(`  ${f}`));
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log(`${C.g}All checks passed.${C.x}`);
  }
}

// ---------- Node and HTTP helpers ----------
function startNode(name) {
  const file = name === 'view' ? 'view/app.js' : `services/${name}.js`;
  nodes[name] = spawn('node', [file], { env, cwd: __dirname, stdio: STDIO });
}

// Drops the test databases so every run starts from the seed data, then starts all nodes.
async function start() {
  const host = process.env.PGHOST || 'localhost';
  const port = Number(process.env.PGPORT || 5433);
  let admin;
  for (let attempt = 1; !admin; attempt++) {
    const c = new Client({ host, port, user: 'p4', password: 'p4', database: 'postgres', connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      admin = c;
    } catch (e) {
      if (attempt === 20) throw new Error(`PostgreSQL is not reachable on ${host}:${port} (${e.message}). Start it with: docker compose up -d db`);
      await sleep(1000); // first start of the db container takes a few seconds
    }
  }
  for (const s of SERVICES) await admin.query(`DROP DATABASE IF EXISTS test_${s} WITH (FORCE)`);
  await admin.end();
  for (const s of SERVICES) startNode(s);
  startNode('view');
}

// Returns { status, location, cookie, body } without following redirects.
async function req(method, url, { cookie, form } = {}) {
  const res = await fetch(BASE + url, {
    method,
    redirect: 'manual',
    headers: { ...(cookie && { cookie }), ...(form && { 'content-type': 'application/x-www-form-urlencoded' }) },
    body: form && new URLSearchParams(form),
  });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('token='));
  return { status: res.status, location: decodeURIComponent(res.headers.get('location') || ''), cookie: set && set.split(';')[0], body: await res.text() };
}

async function login(username) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await req('POST', '/login', { form: { username, password: 'password' } });
      if (r.cookie) return r.cookie;
    } catch {} // view node not up yet
    await sleep(250);
  }
  throw new Error(`could not log in as ${username}`);
}

// Polls a page until its body matches `re` (up to ~10s), then records the final result. Used after restarting a node.
async function waitFor(label, cookie, page, re) {
  let r = { body: '' };
  for (let i = 0; i < 40 && !re.test(r.body); i++) {
    try {
      r = await req('GET', page, { cookie });
    } catch {}
    if (!re.test(r.body)) await sleep(250);
  }
  expectMatch(label, r, re);
}

// Waits until every service node has finished creating its database and answers normally.
async function ready(cookie) {
  for (const p of ['/courses', '/grades', '/announcements', '/schedule']) {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await req('GET', p, { cookie });
        if (r.status === 200 && !/service is down|unavailable/.test(r.body)) break;
      } catch {}
      await sleep(250);
    }
  }
}

// Every page in `pages` must load normally: [path, regex that proves it rendered real data].
async function stillWorking(cookie, pages, context) {
  for (const [p, re] of pages) expectMatch(`${p} still works ${context}`, await req('GET', p, { cookie }), re);
}

async function main() {
  await start();
  const student = await login('student1');
  await ready(student);
  const tokenOf = (cookie) => cookie.split('=')[1];

  // ---------- Spec 1: login / logout, sessions tracked across nodes (JWT) ----------
  section('Spec 1: login / logout, sessions across nodes (JWT)');
  expectMatch('Login with a wrong password is rejected', await req('POST', '/login', { form: { username: 'student1', password: 'nope' } }), /Wrong username or password/);
  expectEqual('No cookie: /courses redirects to the login page', (await req('GET', '/courses')).location, '/login');
  expectEqual('Junk token: /courses redirects to the login page', (await req('GET', '/courses', { cookie: 'token=garbage' })).location, '/login');

  // A token signed with the wrong secret (claiming faculty) is rejected by the view AND by every service node directly.
  const forged = jwt.sign({ sub: 'student1', role: 'faculty' }, 'wrong-secret');
  for (const p of ['/courses', '/grades', '/announcements', '/schedule'])
    expectEqual(`View rejects a forged token on ${p}`, (await req('GET', p, { cookie: `token=${forged}` })).location, '/login');
  for (const [svc, method] of [['auth', 'Logout'], ['course', 'ListCourses'], ['grade', 'MyGrades'], ['announcement', 'ListAnnouncements'], ['schedule', 'MySchedule']])
    await expectRejects(`${svc} node rejects a forged token (${method})`, call(svc, method, {}, forged), 'UNAUTHENTICATED');
  // A real student token must not be able to read the internal revocation list (services only).
  await expectRejects('A student token cannot read the revocation list (auth.ListRevoked)', call('auth', 'ListRevoked', {}, tokenOf(student)), 'PERMISSION_DENIED');

  // One login works on every node (the same JWT is accepted by course, grade, announcement, schedule).
  await stillWorking(student, [['/courses', /STDISCM/], ['/grades', /CCPROG1/], ['/announcements', /Enrollment is open/], ['/schedule', /<table|not enrolled/]], 'with one login');

  // ---------- Spec 2 + 3: view courses, students enroll in open courses ----------
  section('Spec 2 + 3: view courses, enroll in open courses');
  expectMatch('Course list shows STDISCM', await req('GET', '/courses', { cookie: student }), /STDISCM/);
  expectMatch('Student can enroll in an open course (STDISCM)', await req('POST', '/courses/STDISCM/enroll', { cookie: student }), /Enrolled in STDISCM/);
  expectMatch('Enrolling twice in the same course is refused', await req('POST', '/courses/STDISCM/enroll', { cookie: student }), /already enrolled/);
  expectMatch('Enrolling in a closed course (CSALGCM) is refused', await req('POST', '/courses/CSALGCM/enroll', { cookie: student }), /not open/);
  expectMatch('Enrolling in a nonexistent course is refused', await req('POST', '/courses/NOSUCH/enroll', { cookie: student }), /does not exist/);

  // Capacity: STDISCM has 2 seats, student1 + student2 fill it, then it is full.
  const student2 = await login('student2');
  expectMatch('Second student takes the last STDISCM seat', await req('POST', '/courses/STDISCM/enroll', { cookie: student2 }), /Enrolled/);
  expectMatch('Course list shows STDISCM full (2 / 2)', await req('GET', '/courses', { cookie: student2 }), /2 \/ 2/);

  // Concurrency: 8 simultaneous enroll requests for the same seat -> exactly one succeeds (row lock in a transaction).
  const burst = await Promise.all(Array.from({ length: 8 }, () => req('POST', '/courses/CSARCH2/enroll', { cookie: student2 })));
  expectEqual('8 simultaneous enrolls for CSARCH2: number that succeeded', burst.filter((r) => /Enrolled in CSARCH2/.test(r.location)).length, 1);
  expectEqual('8 simultaneous enrolls for CSARCH2: number refused as already enrolled', burst.filter((r) => /already enrolled/.test(r.location)).length, 7);
  expectMatch('CSARCH2 seat count is exactly 1 / 3 (no overbooking)', await req('GET', '/courses', { cookie: student2 }), /1 \/ 3/);

  // ---------- Spec 4: students view previous grades (only their own) ----------
  section('Spec 4: students view previous grades');
  const g1 = await req('GET', '/grades', { cookie: student });
  expectMatch('Student sees the "My grades" page', g1, /My grades/);
  expectMatch('student1 sees their own grade (CCPROG2)', g1, /CCPROG2/);
  expectNoMatch('student2 does not see student1\'s grade (CCPROG2)', await req('GET', '/grades', { cookie: student2 }), /CCPROG2/);

  // ---------- Spec 5: faculty upload grades ----------
  section('Spec 5: faculty upload grades');
  const faculty = await login('faculty1');
  expectMatch('Faculty cannot enroll in a course (students only)', await req('POST', '/courses/STDISCM/enroll', { cookie: faculty }), /Only student/);
  expectMatch('Upload with one bad grade (9.9) is rejected', await req('POST', '/grades', { cookie: faculty, form: { csv: 'student1,STDISCM,4.0\nstudent2,STDISCM,9.9' } }), /9\.9.*grade must be/);
  expectMatch('Valid upload of 2 grades is saved', await req('POST', '/grades', { cookie: faculty, form: { csv: 'student1,STDISCM,4.0\nstudent2,STDISCM,3.5' } }), /Saved 2 grades/);
  expectMatch('A student cannot upload grades', await req('POST', '/grades', { cookie: student, form: { csv: 'student1,STDISCM,4.0' } }), /Only faculty/);
  expectMatch('Student sees the uploaded STDISCM grade', await req('GET', '/grades', { cookie: student }), /STDISCM/);
  const all = await req('GET', '/grades', { cookie: faculty });
  expectMatch('Faculty see the "All grades" page', all, /All grades/);
  expectMatch('Faculty see student1\'s grades', all, /student1/);
  expectMatch('Faculty see student2\'s grades', all, /student2/);

  // Input validation edge cases: bad uploads change nothing and never crash the view.
  section('Input validation: bad uploads change nothing and never crash the view');
  const upload = (csv) => req('POST', '/grades', { cookie: faculty, form: { csv } });
  expectMatch('CSV line with 4 fields is rejected', await upload('student1,STDISCM,4.0,oops'), /each line must be/);
  expectMatch('CSV line with 2 fields is rejected', await upload('student1,4.0'), /each line must be/);
  expectMatch('Same student and course twice in one upload is rejected', await upload('student1,STDISCM,4.0\nstudent1,STDISCM,1.0'), /appears twice/);
  expectMatch('HTML in the course code is rejected', await upload('student1,<b>x</b>,4.0'), /invalid course code/);
  expectMatch('Space in the student username is rejected', await upload('student 1,STDISCM,4.0'), /invalid student/);
  expectMatch('Grade 3.25 is rejected (not an allowed grade)', await upload('student1,STDISCM,3.25'), /grade must be/);
  expectMatch('Empty upload is rejected', await upload('\n \n'), /No grades given/);
  expectMatch('Header row is skipped and grade "3" is saved', await upload('student,course,grade\r\nstudent2,CSARCH2,3'), /Saved 1 grade\./);
  expectMatch('Grade "3" is stored as 3.0', await req('GET', '/grades', { cookie: student2 }), /CSARCH2<\/td><td>3\.0/);
  expectEqual('POST /grades with no form body redirects (no 500)', (await req('POST', '/grades', { cookie: faculty })).status, 302);
  expectMatch('Oversized upload (200 KB) is refused with a message', await req('POST', '/grades', { cookie: faculty, form: { csv: 'x'.repeat(200_000) } }), /too large/);
  expectMatch('Login with no form body asks for username and password', await req('POST', '/login'), /Enter your username/);
  expectEqual('Username with surrounding spaces still logs in (trimmed)', !!(await req('POST', '/login', { form: { username: ' student1 ', password: 'password' } })).cookie, true);
  expectMatch('A 5000-character course code is rejected', await req('POST', `/courses/${'A'.repeat(5000)}/enroll`, { cookie: student }), /Invalid course code/);
  expectMatch('Course code is case-insensitive (csopesy)', await req('POST', '/courses/csopesy/enroll', { cookie: student }), /Enrolled in CSOPESY/);

  // ---------- Bonus: extra feature nodes (announcements, schedule) ----------
  section('Bonus: announcement and schedule nodes');
  expectMatch('Student sees the seeded announcement', await req('GET', '/announcements', { cookie: student }), /Enrollment is open/);
  expectMatch('Faculty can post an announcement', await req('POST', '/announcements', { cookie: faculty, form: { title: 'Exam moved', body: 'Line 1\nLine 2' } }), /posted/);
  expectMatch('Other students see the new announcement', await req('GET', '/announcements', { cookie: student2 }), /Exam moved/);
  expectMatch('A student cannot post an announcement', await req('POST', '/announcements', { cookie: student, form: { title: 'hi', body: 'hi' } }), /Only faculty/);
  expectMatch('Announcement with a blank title is rejected', await req('POST', '/announcements', { cookie: faculty, form: { title: '   ', body: 'x' } }), /Title must be/);
  expectMatch('Announcement with a 2001-character message is rejected', await req('POST', '/announcements', { cookie: faculty, form: { title: 't', body: 'x'.repeat(2001) } }), /Message must be/);

  // Schedule: student sees only their enrolled classes (schedule node asks the course node over gRPC); faculty sees all.
  const sched = await req('GET', '/schedule', { cookie: student }); // student1 is in STDISCM and CSOPESY
  expectMatch('student1 schedule includes STDISCM (enrolled)', sched, /STDISCM/);
  expectMatch('student1 schedule includes CSOPESY (enrolled)', sched, /CSOPESY/);
  expectNoMatch('student1 schedule excludes CSARCH2 (not enrolled)', sched, /CSARCH2/);
  expectMatch('Faculty schedule shows every class (CSALGCM)', await req('GET', '/schedule', { cookie: faculty }), /CSALGCM/);

  // ---------- Logout revokes the token on every node (after the next revocation sync) ----------
  section('Spec 1: logout revokes the session on every node');
  const temp = await login('student2');
  await stillWorking(temp, [['/courses', /STDISCM/], ['/grades', /CSARCH2/]], 'before logout');
  await req('POST', '/logout', { cookie: temp });
  await sleep(1500); // > REVOKE_POLL_MS
  for (const p of ['/courses', '/grades', '/announcements', '/schedule'])
    expectMatch(`Logged-out token is rejected on ${p}`, await req('GET', p, { cookie: temp }), /^\/login\?error=Please log in again/);

  // ---------- Fault tolerance: when a node is down only its features stop; the rest keeps working ----------
  section('Fault tolerance: a node goes down, the rest keeps working');
  const everything = {
    courses: ['/courses', /STDISCM/],
    grades: ['/grades', /CCPROG1/],
    announcements: ['/announcements', /Enrollment is open/],
    schedule: ['/schedule', /STDISCM/],
  };
  const others = (...skip) => Object.entries(everything).filter(([k]) => !skip.includes(k)).map(([, v]) => v);

  // Grade node down -> grades page says so; every other page works.
  nodes.grade.kill();
  await sleep(500);
  expectMatch('Grade node down: /grades says the grade service is down', await req('GET', '/grades', { cookie: student }), /grade service is down/);
  await stillWorking(student, others('grades'), 'with grade node down');
  expectMatch('Grade node down: grade upload reports the service is down', await req('POST', '/grades', { cookie: faculty, form: { csv: 'student1,CSARCH2,2.0' } }), /grade service is down/);

  // Grade node restarts -> view reconnects on its own, and the uploaded grade survived (persisted in PostgreSQL).
  startNode('grade');
  await waitFor('Grade node restarted: /grades works again with the earlier upload intact', student, '/grades', /STDISCM/);

  // Auth node down -> new logins fail, but existing sessions keep working on every node (JWT is verified locally).
  nodes.auth.kill();
  await sleep(500);
  expectMatch('Auth node down: new login says the auth service is down', await req('POST', '/login', { form: { username: 'student2', password: 'password' } }), /auth service is down/);
  await stillWorking(student2, [['/courses', /STDISCM/], ['/grades', /CCPROG1/], ['/announcements', /Enrollment is open/], ['/schedule', /<table/]], 'for an existing session with auth node down');
  expectEqual('Auth node down: logout still works locally', (await req('POST', '/logout', { cookie: temp })).location, '/login');

  // Auth node restarts -> logins work again.
  startNode('auth');
  expectEqual('Auth node restarted: login works again', !!(await login('student2')), true);

  // Course node down -> courses page says so; every page that doesn't need it keeps working.
  nodes.course.kill();
  await sleep(500);
  expectMatch('Course node down: /courses says the course service is down', await req('GET', '/courses', { cookie: student }), /course service is down/);
  expectMatch('Course node down: enrolling reports the service is down', await req('POST', '/courses/CSARCH2/enroll', { cookie: student }), /course service is down/);
  await stillWorking(student, others('courses', 'schedule'), 'with course node down');

  // Schedule node degrades when the course node it depends on is down: shows all classes with a note.
  const degraded = await req('GET', '/schedule', { cookie: student });
  expectMatch('Course node down: schedule shows a note that enrollments could not be loaded', degraded, /course service is down, so your enrollments could not be loaded/);
  expectMatch('Course node down: schedule falls back to all classes (CSARCH2 visible)', degraded, /CSARCH2/);

  // Course node restarts -> enrollments persisted, courses page and filtered schedule are back.
  startNode('course');
  await waitFor('Course node restarted: enrollments survived (STDISCM still 2 / 2)', student, '/courses', /2 \/ 2/);
  await waitFor('Course node restarted: schedule shows STDISCM again', student, '/schedule', /STDISCM/);
  const restored = await req('GET', '/schedule', { cookie: student });
  expectNoMatch('Course node restarted: schedule no longer shows the degraded note', restored, /could not be loaded/);
  expectNoMatch('Course node restarted: schedule is filtered again (no CSARCH2)', restored, /CSARCH2/);

  // Announcement node down -> only announcements stop.
  nodes.announcement.kill();
  await sleep(500);
  expectMatch('Announcement node down: /announcements says the service is down', await req('GET', '/announcements', { cookie: student }), /announcement service is down/);
  await stillWorking(student, others('announcements'), 'with announcement node down');
  startNode('announcement');
  await waitFor('Announcement node restarted: the posted announcement survived', student, '/announcements', /Exam moved/);

  // Schedule node down -> only schedule stops.
  nodes.schedule.kill();
  await sleep(500);
  expectMatch('Schedule node down: /schedule says the service is down', await req('GET', '/schedule', { cookie: student }), /schedule service is down/);
  await stillWorking(student, others('schedule'), 'with schedule node down');

  // Worst case: every service down at once -> the view node itself is still up and serves its own pages.
  section('Fault tolerance: every service node down, view node still up');
  for (const s of ['grade', 'course', 'announcement', 'auth']) nodes[s].kill();
  await sleep(700);
  expectEqual('All services down: /login page still loads (HTTP status)', (await req('GET', '/login')).status, 200);
  for (const [p, name] of [['/courses', 'course'], ['/grades', 'grade'], ['/announcements', 'announcement'], ['/schedule', 'schedule']]) {
    const r = await req('GET', p, { cookie: student });
    expectEqual(`All services down: ${p} renders an error page, not a crash (HTTP status)`, r.status, 200);
    expectMatch(`All services down: ${p} says the ${name} service is down`, r, new RegExp(`${name} service is down`));
  }
}

main()
  .catch((e) => {
    console.error(`\n${C.r}Test run aborted:${C.x}`, e);
    process.exitCode = 1;
  })
  .finally(() => {
    Object.values(nodes).forEach((n) => n.kill());
    summary();
    console.log(`Report saved to ${REPORT}`);
    process.exit(process.exitCode || 0); // the test's own gRPC clients would otherwise keep the process alive
  });
// End-to-end check: starts all nodes on spare ports with a throwaway database, runs the main flows,
// then kills nodes one by one and checks that the rest of the app keeps working. Run: npm test
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the test's view node uses a throwaway self-signed cert
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-test-'));
const env = {
  ...process.env,
  CERT_DIR: tmp,
  AUTH_ADDR: 'localhost:51051',
  COURSE_ADDR: 'localhost:51052',
  GRADE_ADDR: 'localhost:51053',
  ANNOUNCEMENT_ADDR: 'localhost:51054',
  SCHEDULE_ADDR: 'localhost:51055',
  VIEW_PORT: '3100',
  DATA_DIR: tmp,
};
const BASE = 'https://localhost:3100';
const nodes = {};
for (const name of ['auth', 'course', 'grade', 'announcement', 'schedule']) nodes[name] = spawn('node', [`services/${name}.js`], { env, cwd: __dirname });
nodes.view = spawn('node', ['view/app.js'], { env, cwd: __dirname });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const student = await login('student1');

  // Bad password is rejected.
  assert.match((await req('POST', '/login', { form: { username: 'student1', password: 'nope' } })).body, /Wrong username or password/);

  // View courses, enroll, can't enroll twice, closed course refused.
  assert.match((await req('GET', '/courses', { cookie: student })).body, /STDISCM/);
  assert.match((await req('POST', '/courses/STDISCM/enroll', { cookie: student })).location, /Enrolled in STDISCM/);
  assert.match((await req('POST', '/courses/STDISCM/enroll', { cookie: student })).location, /already enrolled/);
  assert.match((await req('POST', '/courses/CSALGCM/enroll', { cookie: student })).location, /not open/);

  // Capacity: STDISCM has 2 seats, student1 + student2 fill it, then it is full.
  const student2 = await login('student2');
  assert.match((await req('POST', '/courses/STDISCM/enroll', { cookie: student2 })).location, /Enrolled/);
  assert.match((await req('GET', '/courses', { cookie: student2 })).body, /2 \/ 2/);

  // Previous grades: students see only their own.
  const g1 = (await req('GET', '/grades', { cookie: student })).body;
  assert.match(g1, /CCPROG2/);
  assert.doesNotMatch((await req('GET', '/grades', { cookie: student2 })).body, /CCPROG2/);

  // Faculty uploads; bad line rejects the whole upload; students cannot upload.
  const faculty = await login('faculty1');
  assert.match((await req('POST', '/courses/STDISCM/enroll', { cookie: faculty })).location, /Only student/);
  assert.match((await req('POST', '/grades', { cookie: faculty, form: { csv: 'student1,STDISCM,4.0\nstudent2,STDISCM,9.9' } })).location, /9\.9.*grade must be/);
  assert.match((await req('POST', '/grades', { cookie: faculty, form: { csv: 'student1,STDISCM,4.0\nstudent2,STDISCM,3.5' } })).location, /Saved 2 grades/);
  assert.match((await req('POST', '/grades', { cookie: student, form: { csv: 'student1,STDISCM,4.0' } })).location, /Only faculty/);
  assert.match((await req('GET', '/grades', { cookie: student })).body, /STDISCM/);

  // Input validation edge cases: bad uploads change nothing and never crash the view.
  const upload = async (csv) => (await req('POST', '/grades', { cookie: faculty, form: { csv } })).location;
  assert.match(await upload('student1,STDISCM,4.0,oops'), /each line must be/);
  assert.match(await upload('student1,4.0'), /each line must be/);
  assert.match(await upload('student1,STDISCM,4.0\nstudent1,STDISCM,1.0'), /appears twice/);
  assert.match(await upload('student1,<b>x</b>,4.0'), /invalid course code/);
  assert.match(await upload('student 1,STDISCM,4.0'), /invalid student/);
  assert.match(await upload('student1,STDISCM,3.25'), /grade must be/);
  assert.match(await upload('\n \n'), /No grades given/);
  assert.match(await upload('student,course,grade\r\nstudent2,CSARCH2,3'), /Saved 1 grade\./); // header skipped, "3" stored as 3.0
  assert.match((await req('GET', '/grades', { cookie: student2 })).body, /CSARCH2<\/td><td>3\.0/);
  assert.equal((await req('POST', '/grades', { cookie: faculty })).status, 302); // no form body: no 500
  assert.match((await req('POST', '/grades', { cookie: faculty, form: { csv: 'x'.repeat(200_000) } })).location, /too large/);
  assert.match((await req('POST', '/login')).body, /Enter your username/);
  assert.ok((await req('POST', '/login', { form: { username: ' student1 ', password: 'password' } })).cookie); // trimmed
  assert.match((await req('POST', `/courses/${'A'.repeat(5000)}/enroll`, { cookie: student })).location, /Invalid course code/);
  assert.match((await req('POST', '/courses/csopesy/enroll', { cookie: student })).location, /Enrolled in CSOPESY/); // case-insensitive

  // Announcements: faculty post, everyone reads, students cannot post, empty posts rejected.
  assert.match((await req('GET', '/announcements', { cookie: student })).body, /Enrollment is open/);
  assert.match((await req('POST', '/announcements', { cookie: faculty, form: { title: 'Exam moved', body: 'Line 1\nLine 2' } })).location, /posted/);
  assert.match((await req('GET', '/announcements', { cookie: student2 })).body, /Exam moved/);
  assert.match((await req('POST', '/announcements', { cookie: student, form: { title: 'hi', body: 'hi' } })).location, /Only faculty/);
  assert.match((await req('POST', '/announcements', { cookie: faculty, form: { title: '   ', body: 'x' } })).location, /Title must be/);
  assert.match((await req('POST', '/announcements', { cookie: faculty, form: { title: 't', body: 'x'.repeat(2001) } })).location, /Message must be/);

  // Schedule: student sees only their enrolled classes (schedule node asks the course node over gRPC); faculty sees all.
  const sched = (await req('GET', '/schedule', { cookie: student })).body; // student1 is in STDISCM and CSOPESY
  assert.match(sched, /STDISCM/);
  assert.match(sched, /CSOPESY/);
  assert.doesNotMatch(sched, /CSARCH2/);
  assert.match((await req('GET', '/schedule', { cookie: faculty })).body, /CSALGCM/);

  // Fault tolerance: grade node down -> grades page says so, courses still work.
  nodes.grade.kill();
  await sleep(500);
  assert.match((await req('GET', '/grades', { cookie: student })).body, /grade service is down/);
  assert.match((await req('GET', '/courses', { cookie: student })).body, /STDISCM/);

  // Grade node restarts -> view reconnects on its own, and the uploaded grade survived (persisted in SQLite).
  nodes.grade = spawn('node', ['services/grade.js'], { env, cwd: __dirname });
  let back = '';
  for (let i = 0; i < 20 && !/STDISCM/.test(back); i++) {
    await sleep(250);
    back = (await req('GET', '/grades', { cookie: student })).body;
  }
  assert.match(back, /STDISCM/);

  // Auth node down -> new logins fail, but existing sessions keep working (JWT is verified locally).
  nodes.auth.kill();
  await sleep(500);
  assert.match((await req('POST', '/login', { form: { username: 'student2', password: 'password' } })).body, /auth service is down/);
  assert.match((await req('GET', '/courses', { cookie: student2 })).body, /STDISCM/);

  // Course node down -> courses page says so, view node itself still serves pages.
  nodes.course.kill();
  await sleep(500);
  assert.match((await req('GET', '/courses', { cookie: student })).body, /course service is down/);

  // Schedule node degrades when the course node it depends on is down: shows all classes with a note.
  const degraded = (await req('GET', '/schedule', { cookie: student })).body;
  assert.match(degraded, /course service is down, so your enrollments could not be loaded/);
  assert.match(degraded, /CSARCH2/);

  // Announcement and schedule nodes down -> only their pages say so.
  nodes.announcement.kill();
  nodes.schedule.kill();
  await sleep(500);
  assert.match((await req('GET', '/announcements', { cookie: student })).body, /announcement service is down/);
  assert.match((await req('GET', '/schedule', { cookie: student })).body, /schedule service is down/);
  assert.match((await req('GET', '/grades', { cookie: student })).body, /CCPROG1/);

  // Logout still works locally when auth is down.
  assert.equal((await req('POST', '/logout', { cookie: student })).location, '/login');

  console.log('All checks passed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => Object.values(nodes).forEach((n) => n.kill()));

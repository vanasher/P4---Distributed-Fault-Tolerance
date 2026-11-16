// Course node: lists courses and handles enrollment.
const { fail, requireUser, openDb, serve } = require('../shared/common');

const db = openDb('course.db', `
  CREATE TABLE IF NOT EXISTS courses (code TEXT PRIMARY KEY, title TEXT, capacity INTEGER, open INTEGER);
  CREATE TABLE IF NOT EXISTS enrollments (student TEXT, code TEXT, PRIMARY KEY (student, code));
`);

if (!db.prepare('SELECT 1 FROM courses').get()) {
  const add = db.prepare('INSERT INTO courses VALUES (?, ?, ?, ?)');
  add.run('CSOPESY', 'Introduction to Operating Systems', 2, 1);
  add.run('STDISCM', 'Distributed Computing', 2, 1);
  add.run('CSARCH2', 'Computer Architecture 2', 3, 1);
  add.run('CSALGCM', 'Algorithmic Complexity', 3, 0);
}

serve('Course', {
  ListCourses(call) {
    const user = requireUser(call);
    const rows = db.prepare(`
      SELECT c.code, c.title, c.capacity, c.open,
        (SELECT COUNT(*) FROM enrollments e WHERE e.code = c.code) AS enrolled,
        EXISTS (SELECT 1 FROM enrollments e WHERE e.code = c.code AND e.student = ?) AS mine
      FROM courses c ORDER BY c.code`).all(user.sub);
    return { courses: rows.map((c) => ({ ...c, open: !!c.open, mine: !!c.mine })) };
  },

  // Node runs this synchronously on one thread, so the capacity check and the insert cannot interleave
  // with another enrollment. No two students can take the last seat.
  Enroll(call) {
    const user = requireUser(call, 'student');
    const code = call.request.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,12}$/.test(code)) fail('INVALID_ARGUMENT', 'Invalid course code.');
    const course = db.prepare('SELECT * FROM courses WHERE code = ?').get(code);
    if (!course) fail('NOT_FOUND', `Course ${code} does not exist.`);
    if (!course.open) fail('FAILED_PRECONDITION', `${course.code} is not open for enrollment.`);
    if (db.prepare('SELECT 1 FROM enrollments WHERE student = ? AND code = ?').get(user.sub, course.code))
      fail('ALREADY_EXISTS', `You are already enrolled in ${course.code}.`);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE code = ?').get(course.code);
    if (n >= course.capacity) fail('RESOURCE_EXHAUSTED', `${course.code} is full.`);
    db.prepare('INSERT INTO enrollments VALUES (?, ?)').run(user.sub, course.code);
    return {};
  },
});

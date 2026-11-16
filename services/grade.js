// Grade node: students view grades, faculty upload them.
const { fail, requireUser, openDb, serve } = require('../shared/common');

const GRADES = ['4.0', '3.5', '3.0', '2.5', '2.0', '1.5', '1.0', '0.0'];
const MAX_ROWS = 1000;
const clip = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s);

const db = openDb('grade.db', `
  CREATE TABLE IF NOT EXISTS grades (student TEXT, course TEXT, grade TEXT, PRIMARY KEY (student, course));
`);

if (!db.prepare('SELECT 1 FROM grades').get()) {
  const add = db.prepare('INSERT INTO grades VALUES (?, ?, ?)');
  add.run('student1', 'CCPROG1', '4.0');
  add.run('student1', 'CCPROG2', '3.5');
  add.run('student2', 'CCPROG1', '3.0');
}

serve('Grade', {
  MyGrades(call) {
    const user = requireUser(call);
    const grades = user.role === 'faculty'
      ? db.prepare('SELECT * FROM grades ORDER BY student, course').all()
      : db.prepare('SELECT * FROM grades WHERE student = ? ORDER BY course').all(user.sub);
    return { grades };
  },

  UploadGrades(call) {
    requireUser(call, 'faculty');
    const entries = call.request.grades;
    if (!entries.length) fail('INVALID_ARGUMENT', 'No grades given.');
    if (entries.length > MAX_ROWS) fail('INVALID_ARGUMENT', `Upload at most ${MAX_ROWS} grades at a time.`);

    // Validate every entry before writing any, so a bad upload changes nothing.
    const seen = new Set();
    const rows = entries.map((g) => {
      const row = { student: g.student.trim(), course: g.course.trim().toUpperCase(), grade: g.grade.trim() };
      const where = `"${clip(`${g.student},${g.course},${g.grade}`)}"`;
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(row.student)) fail('INVALID_ARGUMENT', `${where}: invalid student username.`);
      if (!/^[A-Z0-9-]{2,12}$/.test(row.course)) fail('INVALID_ARGUMENT', `${where}: invalid course code.`);
      // Accept "4", "4.0", "4.00"; store the canonical "4.0". Rejects "3.25", "4.5", "", "abc".
      row.grade = /^\d+(\.\d+)?$/.test(row.grade) && GRADES.find((x) => Number(x) === Number(row.grade));
      if (!row.grade) fail('INVALID_ARGUMENT', `${where}: grade must be one of ${GRADES.join(', ')}.`);
      const key = `${row.student}|${row.course}`;
      if (seen.has(key)) fail('INVALID_ARGUMENT', `${where}: ${row.student} appears twice for ${row.course}.`);
      seen.add(key);
      return row;
    });
    const save = db.prepare('INSERT INTO grades VALUES (?, ?, ?) ON CONFLICT (student, course) DO UPDATE SET grade = excluded.grade');
    for (const g of rows) save.run(g.student, g.course, g.grade);
    return { saved: rows.length };
  },
});

// Grade node: students view grades, faculty upload them.
const { fail, requireUser, openDb, serve } = require('../shared/common');

const GRADES = ['4.0', '3.5', '3.0', '2.5', '2.0', '1.5', '1.0', '0.0'];

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
    const rows = call.request.grades.map((g) => ({ student: g.student.trim(), course: g.course.trim().toUpperCase(), grade: g.grade.trim() }));
    if (!rows.length) fail('INVALID_ARGUMENT', 'No grades given.');
    // Validate every line before writing any, so a bad upload changes nothing.
    rows.forEach((g, i) => {
      if (!g.student || !g.course) fail('INVALID_ARGUMENT', `Line ${i + 1}: student and course are required.`);
      if (!GRADES.includes(g.grade)) fail('INVALID_ARGUMENT', `Line ${i + 1}: grade must be one of ${GRADES.join(', ')}.`);
    });
    const save = db.prepare('INSERT INTO grades VALUES (?, ?, ?) ON CONFLICT (student, course) DO UPDATE SET grade = excluded.grade');
    for (const g of rows) save.run(g.student, g.course, g.grade);
    return { saved: rows.length };
  },
});

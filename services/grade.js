// Grade node: students view grades, faculty upload them.
const { fail, requireUser, openDb, serve, main } = require('../shared/common');

const GRADES = ['4.0', '3.5', '3.0', '2.5', '2.0', '1.5', '1.0', '0.0'];
const MAX_ROWS = 1000;
const clip = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s);

main(async () => {
  const db = await openDb('grade', `
    CREATE TABLE IF NOT EXISTS grades (student TEXT, course TEXT, grade TEXT NOT NULL, PRIMARY KEY (student, course));
  `);

  await db.query(`
    INSERT INTO grades VALUES ('student1', 'CCPROG1', '4.0'), ('student1', 'CCPROG2', '3.5'), ('student2', 'CCPROG1', '3.0')
    ON CONFLICT DO NOTHING`);

  serve('Grade', {
    async MyGrades(call) {
      const user = requireUser(call);
      const { rows } = user.role === 'faculty'
        ? await db.query('SELECT * FROM grades ORDER BY student, course')
        : await db.query('SELECT * FROM grades WHERE student = $1 ORDER BY course', [user.sub]);
      return { grades: rows };
    },

    async UploadGrades(call) {
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

      // One statement for the whole upload, so it is saved all-or-nothing.
      await db.query(
        `INSERT INTO grades (student, course, grade)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
         ON CONFLICT (student, course) DO UPDATE SET grade = EXCLUDED.grade`,
        [rows.map((r) => r.student), rows.map((r) => r.course), rows.map((r) => r.grade)]
      );
      return { saved: rows.length };
    },
  });
});

// Course node: lists courses and handles enrollment.
const { fail, requireUser, openDb, transaction, serve, main } = require('../shared/common');

main(async () => {
  const db = await openDb('course', `
    CREATE TABLE IF NOT EXISTS courses (code TEXT PRIMARY KEY, title TEXT NOT NULL, capacity INT NOT NULL, open BOOLEAN NOT NULL);
    CREATE TABLE IF NOT EXISTS enrollments (student TEXT, code TEXT REFERENCES courses, PRIMARY KEY (student, code));
  `);

  await db.query(`
    INSERT INTO courses VALUES
      ('CSOPESY', 'Introduction to Operating Systems', 2, true),
      ('STDISCM', 'Distributed Computing', 2, true),
      ('CSARCH2', 'Computer Architecture 2', 3, true),
      ('CSALGCM', 'Algorithmic Complexity', 3, false)
    ON CONFLICT DO NOTHING`);

  serve('Course', {
    async ListCourses(call) {
      const user = requireUser(call);
      const { rows } = await db.query(`
        SELECT c.code, c.title, c.capacity, c.open,
          (SELECT COUNT(*)::int FROM enrollments e WHERE e.code = c.code) AS enrolled,
          EXISTS (SELECT 1 FROM enrollments e WHERE e.code = c.code AND e.student = $1) AS mine
        FROM courses c ORDER BY c.code`, [user.sub]);
      return { courses: rows };
    },

    // Runs in a transaction that locks the course row (FOR UPDATE), so concurrent enrollments for the
    // same course wait their turn: the seat count can't be read by two requests at once, no overbooking.
    async Enroll(call) {
      const user = requireUser(call, 'student');
      const code = call.request.code.trim().toUpperCase();
      if (!/^[A-Z0-9-]{2,12}$/.test(code)) fail('INVALID_ARGUMENT', 'Invalid course code.');

      try {
        await transaction(async (tx) => {
          const { rows: [course] } = await tx.query('SELECT * FROM courses WHERE code = $1 FOR UPDATE', [code]);
          if (!course) fail('NOT_FOUND', `Course ${code} does not exist.`);
          if (!course.open) fail('FAILED_PRECONDITION', `${code} is not open for enrollment.`);
          const mine = await tx.query('SELECT 1 FROM enrollments WHERE student = $1 AND code = $2', [user.sub, code]);
          if (mine.rowCount) fail('ALREADY_EXISTS', `You are already enrolled in ${code}.`);
          const { rows: [{ n }] } = await tx.query('SELECT COUNT(*)::int AS n FROM enrollments WHERE code = $1', [code]);
          if (n >= course.capacity) fail('RESOURCE_EXHAUSTED', `${code} is full.`);
          await tx.query('INSERT INTO enrollments VALUES ($1, $2)', [user.sub, code]);
        });
      } catch (e) {
        if (e.code === '23505') fail('ALREADY_EXISTS', `You are already enrolled in ${code}.`); // unique key backstop
        throw e;
      }
      return {};
    },
  });
});

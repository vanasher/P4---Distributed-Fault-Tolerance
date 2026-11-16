// Schedule node: class timetable. Owns the class times; asks the course node (gRPC) which courses a student is in.
const { requireUser, openDb, serve, main } = require('../shared/common');
const { call: rpc } = require('../shared/clients');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

main(async () => {
  const db = await openDb('schedule', `
    CREATE TABLE IF NOT EXISTS slots (code TEXT NOT NULL, day INT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, room TEXT NOT NULL);
  `);

  const { rowCount } = await db.query('SELECT 1 FROM slots LIMIT 1');
  if (!rowCount) {
    await db.query(`
      INSERT INTO slots VALUES
        ('CSOPESY', 0, '09:15', '10:45', 'GK306'), ('CSOPESY', 3, '09:15', '10:45', 'GK306'),
        ('STDISCM', 1, '11:00', '12:30', 'AG1104'), ('STDISCM', 4, '11:00', '12:30', 'AG1104'),
        ('CSARCH2', 0, '12:45', '14:15', 'GK210'), ('CSARCH2', 3, '12:45', '14:15', 'GK210'),
        ('CSALGCM', 1, '14:30', '16:00', 'AG1906'), ('CSALGCM', 4, '14:30', '16:00', 'AG1906')`);
  }

  const allSlots = async () => {
    const { rows } = await db.query('SELECT code, day, start_time, end_time, room FROM slots ORDER BY day, start_time');
    return rows.map((s) => ({ code: s.code, day: DAYS[s.day], start: s.start_time, end: s.end_time, room: s.room }));
  };

  serve('Schedule', {
    async MySchedule(call) {
      const user = requireUser(call);
      if (user.role !== 'student') return { slots: await allSlots() };

      // Node-to-node gRPC: forward the student's token to the course node to get their enrollments.
      // If the course node is down, degrade instead of failing: show every class and say why.
      let courses;
      try {
        ({ courses } = await rpc('course', 'ListCourses', {}, call.metadata.get('authorization')[0], 1000));
      } catch (err) {
        if (!err.down) throw err;
        return { slots: await allSlots(), note: 'The course service is down, so your enrollments could not be loaded. Showing all classes.' };
      }
      const mine = new Set(courses.filter((c) => c.mine).map((c) => c.code));
      return { slots: (await allSlots()).filter((s) => mine.has(s.code)) };
    },
  });
});

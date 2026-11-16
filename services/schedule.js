// Schedule node: class timetable. Owns the class times; asks the course node (gRPC) which courses a student is in.
const { requireUser, openDb, serve } = require('../shared/common');
const { call: rpc } = require('../shared/clients');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const db = openDb('schedule.db', `
  CREATE TABLE IF NOT EXISTS slots (code TEXT, day INTEGER, start TEXT, end TEXT, room TEXT);
`);

if (!db.prepare('SELECT 1 FROM slots').get()) {
  const add = db.prepare('INSERT INTO slots VALUES (?, ?, ?, ?, ?)');
  for (const [code, days, start, end, room] of [
    ['CSOPESY', [0, 3], '09:15', '10:45', 'GK306'],
    ['STDISCM', [1, 4], '11:00', '12:30', 'AG1104'],
    ['CSARCH2', [0, 3], '12:45', '14:15', 'GK210'],
    ['CSALGCM', [1, 4], '14:30', '16:00', 'AG1906'],
  ]) for (const day of days) add.run(code, day, start, end, room);
}

const allSlots = () =>
  db.prepare('SELECT code, day, start, end, room FROM slots ORDER BY day, start').all().map((s) => ({ ...s, day: DAYS[s.day] }));

serve('Schedule', {
  async MySchedule(call) {
    const user = requireUser(call);
    if (user.role !== 'student') return { slots: allSlots() };

    // Node-to-node gRPC: forward the student's token to the course node to get their enrollments.
    // If the course node is down, degrade instead of failing: show every class and say why.
    let courses;
    try {
      ({ courses } = await rpc('course', 'ListCourses', {}, call.metadata.get('authorization')[0], 1000));
    } catch (err) {
      if (!err.down) throw err;
      return { slots: allSlots(), note: 'The course service is down, so your enrollments could not be loaded. Showing all classes.' };
    }
    const mine = new Set(courses.filter((c) => c.mine).map((c) => c.code));
    return { slots: allSlots().filter((s) => mine.has(s.code)) };
  },
});

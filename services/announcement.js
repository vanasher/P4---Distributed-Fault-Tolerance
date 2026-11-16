// Announcement node: faculty post announcements, everyone reads them.
const { fail, requireUser, openDb, serve, main } = require('../shared/common');

main(async () => {
  const db = await openDb('announcement', `
    CREATE TABLE IF NOT EXISTS announcements (
      id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, author TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      posted TIMESTAMPTZ NOT NULL DEFAULT now());
  `);

  const { rowCount } = await db.query('SELECT 1 FROM announcements LIMIT 1');
  if (!rowCount) {
    await db.query('INSERT INTO announcements (author, title, body) VALUES ($1, $2, $3)', [
      'faculty1', 'Enrollment is open', 'Enrollment for CSOPESY, STDISCM and CSARCH2 is now open. Seats are limited.',
    ]);
  }

  serve('Announcement', {
    async ListAnnouncements(call) {
      requireUser(call);
      const { rows } = await db.query('SELECT author, title, body, posted FROM announcements ORDER BY id DESC');
      return { announcements: rows.map((a) => ({ ...a, posted: a.posted.toISOString() })) };
    },

    async PostAnnouncement(call) {
      const user = requireUser(call, 'faculty');
      const title = call.request.title.trim();
      const body = call.request.body.trim();
      if (!title || title.length > 100) fail('INVALID_ARGUMENT', 'Title must be 1 to 100 characters.');
      if (!body || body.length > 2000) fail('INVALID_ARGUMENT', 'Message must be 1 to 2000 characters.');
      await db.query('INSERT INTO announcements (author, title, body) VALUES ($1, $2, $3)', [user.sub, title, body]);
      return {};
    },
  });
});

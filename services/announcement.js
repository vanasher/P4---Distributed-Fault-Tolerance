// Announcement node: faculty post announcements, everyone reads them.
const { fail, requireUser, openDb, serve } = require('../shared/common');

const db = openDb('announcement.db', `
  CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, title TEXT, body TEXT, posted TEXT);
`);

if (!db.prepare('SELECT 1 FROM announcements').get()) {
  db.prepare('INSERT INTO announcements (author, title, body, posted) VALUES (?, ?, ?, ?)').run(
    'faculty1', 'Enrollment is open', 'Enrollment for CSOPESY, STDISCM and CSARCH2 is now open. Seats are limited.', new Date().toISOString()
  );
}

serve('Announcement', {
  ListAnnouncements(call) {
    requireUser(call);
    return { announcements: db.prepare('SELECT author, title, body, posted FROM announcements ORDER BY id DESC').all() };
  },

  PostAnnouncement(call) {
    const user = requireUser(call, 'faculty');
    const title = call.request.title.trim();
    const body = call.request.body.trim();
    if (!title || title.length > 100) fail('INVALID_ARGUMENT', 'Title must be 1 to 100 characters.');
    if (!body || body.length > 2000) fail('INVALID_ARGUMENT', 'Message must be 1 to 2000 characters.');
    db.prepare('INSERT INTO announcements (author, title, body, posted) VALUES (?, ?, ?, ?)').run(user.sub, title, body, new Date().toISOString());
    return {};
  },
});

const pool = require('../utils/db');

const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
};

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET: Fetch all messages between two users
    if (req.method === 'GET') {
      const { username, chatWith } = req.query;
      if (!username || !chatWith) {
        return res.status(400).json({ error: 'Missing username or chatWith' });
      }

      const [u1, u2] = [username.toLowerCase(), chatWith.toLowerCase()];
      const sql = `
        SELECT id, username, chatwith, message, photo, timestamp, seen
        FROM messages
        WHERE (username = ? AND chatwith = ?) OR (username = ? AND chatwith = ?)
        ORDER BY timestamp;
      `;
      const [rows] = await pool.query(sql, [u1, u2, u2, u1]);

      if (!rows.length) {
        return res.status(404).json({ error: 'No messages found' });
      }

      const messages = rows.map(m => ({
        ...m,
        side: m.username === u1 ? 'user' : 'other',
      }));

      return res.status(200).json({ messages });
    }

    // PUT: Mark a single message as seen
    if (req.method === 'PUT') {
      const { id } = req.body;
      const msgId = parseInt(id);
      if (!msgId) {
        return res.status(400).json({ error: 'Invalid message ID' });
      }

      const [result] = await pool.query('UPDATE messages SET seen = TRUE WHERE id = ?', [msgId]);
      return result.affectedRows
        ? res.status(200).json({ message: 'Message marked as seen' })
        : res.status(404).json({ error: 'Message not found' });
    }

    // PATCH: Batch mark multiple messages as seen
    if (req.method === 'PATCH') {
      const { messageIds, currentUser, chatWith } = req.body;
      if (!Array.isArray(messageIds) || !messageIds.length || !currentUser || !chatWith) {
        return res.status(400).json({ error: 'Invalid request payload' });
      }

      const placeholders = messageIds.map(() => '?').join(', ');
      const updateQuery = `
        UPDATE messages
        SET seen = TRUE
        WHERE id IN (${placeholders})
          AND username = ?
          AND chatwith = ?
      `;
      const params = [...messageIds, chatWith.toLowerCase(), currentUser.toLowerCase()];

      const [result] = await pool.query(updateQuery, params);
      return res.status(200).json({ updated: result.affectedRows });
    }

    // POST: Add a new message
    if (req.method === 'POST') {
      const { username, chatWith, message, photo, timestamp } = req.body;
      if (!username || !chatWith || (!message && !photo)) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const [u1, u2] = [username.toLowerCase(), chatWith.toLowerCase()];
      const photoPath = photo?.startsWith('data:image') ? photo : null;

      const insertSql = `
        INSERT INTO messages (username, chatwith, message, photo, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `;
      const params = [u1, u2, message || '', photoPath, timestamp || new Date().toISOString()];
      const [result] = await pool.query(insertSql, params);

      // Fetch the inserted message (using the insertId)
      const [rows] = await pool.query('SELECT * FROM messages WHERE id = ?', [result.insertId]);
      return res.status(201).json({ message: rows[0] });
    }

    // If method not handled
    return res.status(405).json({ error: 'Method Not Allowed' });

  } catch (err) {
    console.error('❌ Server error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};






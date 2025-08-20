const pool = require('../utils/db');

const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
};

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { username, chatWith } = req.query;
      if (!username || !chatWith) {
        return res.status(400).json({ error: 'Missing username or chatWith' });
      }

      const [u1, u2] = [username.toLowerCase(), chatWith.toLowerCase()];
      const sql = `
        SELECT m.id, m.username, m.chatwith, m.message, m.photo, m.timestamp, m.seen, m.reply_to,
               r.id as reply_id, r.username as reply_username, r.message as reply_message, r.photo as reply_photo
        FROM messages m
        LEFT JOIN messages r ON m.reply_to = r.id
        WHERE (m.username = ? AND m.chatwith = ?) OR (m.username = ? AND m.chatwith = ?)
        ORDER BY m.timestamp;
      `;

      const [rows] = await pool.query(sql, [u1, u2, u2, u1]);
      
      const messages = rows.map(m => ({
        id: m.id,
        username: m.username,
        senderId: m.username,
        chatwith: m.chatwith,
        message: m.message,
        photo: m.photo,
        timestamp: m.timestamp,
        seen: m.seen,
        side: m.username === u1 ? 'user' : 'other',
        replyTo: m.reply_to ? {
          id: m.reply_id,
          username: m.reply_username,
          message: m.reply_message,
          photo: m.reply_photo
        } : null
      }));

      return res.status(200).json({ messages });
    }

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

    if (req.method === 'POST') {
      const { username, chatWith, message, photo, timestamp, replyTo } = req.body;
      if (!username || !chatWith || (!message && !photo)) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const [u1, u2] = [username.toLowerCase(), chatWith.toLowerCase()];
      const photoPath = photo?.startsWith('data:image') ? photo : null;
      const replyId = replyTo?.id || null;

      const insertSql = `
        INSERT INTO messages (username, chatwith, message, photo, timestamp, reply_to)
        VALUES (?, ?, ?, ?, ?, ?)
      `;

      const params = [
        u1, u2, 
        message || '', 
        photoPath, 
        timestamp || new Date().toISOString(),
        replyId
      ];

      const [result] = await pool.query(insertSql, params);

      // Fetch the complete inserted message with reply data
      const [rows] = await pool.query(`
        SELECT m.*, r.id as reply_id, r.username as reply_username, 
               r.message as reply_message, r.photo as reply_photo
        FROM messages m
        LEFT JOIN messages r ON m.reply_to = r.id
        WHERE m.id = ?
      `, [result.insertId]);

      const savedMessage = {
        ...rows[0],
        replyTo: rows[0].reply_to ? {
          id: rows[0].reply_id,
          username: rows[0].reply_username,
          message: rows[0].reply_message,
          photo: rows[0].reply_photo
        } : null
      };

      return res.status(201).json({ message: savedMessage });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });

  } catch (err) {
    console.error('❌ Server error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};




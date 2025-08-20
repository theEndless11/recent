const pool = require('../utils/db');

const setCorsHeaders = res => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
};

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { method, query, body } = req;

  try {
    const connection = await pool.getConnection();

    if (method === 'GET') {
      return await handleGet(req, res, connection, query);
    }

    if (method === 'POST') {
      return await handlePost(req, res, connection, body);
    }

    if (method === 'PATCH') {
      return await handlePatch(req, res, connection, body);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// GET handler
async function handleGet(req, res, connection, query) {
  const { userId, action } = query;

  if (action === 'get') {
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    try {
      const [rows] = await connection.execute(`
        SELECT 
          rc.chat_user_id AS userId,
          rc.chat_user_id AS id,
          rc.last_message AS lastMessage,
          rc.last_seen AS lastSeen,
          rc.unread_count AS unreadCount
        FROM recent_chats rc
        WHERE rc.user_id = ?
        ORDER BY rc.updated_at DESC
        LIMIT 20
      `, [userId]);

      const recentChats = rows.map(row => ({
        userId: row.userId,
        id: row.id,
        lastMessage: row.lastMessage || 'Tap to start chatting',
        lastSeen: row.lastSeen || new Date().toISOString(),
        unreadCount: row.unreadCount || 0
      }));

      return res.status(200).json({ recentChats });

    } catch (error) {
      console.error('Error fetching recent chats:', error);
      return res.status(500).json({ error: 'Failed to fetch recent chats' });
    }
  }

  return res.status(400).json({ error: 'Invalid action for GET request' });
}

// POST handler
async function handlePost(req, res, connection, body) {
  const { action, updates } = body;

  if (action === 'batchUpdate') {
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array is required' });
    }

    try {
      await connection.beginTransaction();

      for (const update of updates) {
        const { userId, chatData } = update;

        if (!userId || !chatData) {
          console.warn('Skipping invalid update:', update);
          continue;
        }

        await connection.execute(`
  INSERT INTO recent_chats (
    user_id, chat_user_id,
    chat_username, chat_profile_picture, -- NEW
    last_message, last_seen, unread_count,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  ON DUPLICATE KEY UPDATE
    chat_username = VALUES(chat_username), -- NEW
    chat_profile_picture = VALUES(chat_profile_picture), -- NEW
    last_message = VALUES(last_message),
    last_seen = VALUES(last_seen),
    unread_count = CASE 
      WHEN VALUES(unread_count) > 0 THEN VALUES(unread_count)
      ELSE unread_count 
    END,
    updated_at = NOW()
`, [
  userId,
  chatData.userId,
  chatData.username,
  chatData.profile_picture,
  chatData.lastMessage,
  chatData.lastSeen,
  chatData.unreadCount || 0
]);

      }

      await connection.commit();
      return res.status(200).json({ success: true, updated: updates.length });

    } catch (error) {
      await connection.rollback();
      console.error('Error in batch update:', error);
      return res.status(500).json({ error: 'Failed to update recent chats' });
    }
  }

  return res.status(400).json({ error: 'Invalid action for POST request' });
}

// PATCH handler
async function handlePatch(req, res, connection, body) {
  const { action, userId, chatUserId } = body;

  if (action === 'clearUnread') {
    if (!userId || !chatUserId) {
      return res.status(400).json({ error: 'userId and chatUserId are required' });
    }

    try {
      const [result] = await connection.execute(`
        UPDATE recent_chats 
        SET unread_count = 0, updated_at = NOW()
        WHERE user_id = ? AND chat_user_id = ?
      `, [userId, chatUserId]);

      if (result.affectedRows === 0) {
        await connection.execute(`
          INSERT INTO recent_chats (
            user_id, chat_user_id,
            last_message, last_seen, unread_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            unread_count = 0,
            updated_at = NOW()
        `, [
          userId,
          chatUserId,
          'Tap to start chatting',
          new Date().toISOString()
        ]);
      }

      return res.status(200).json({ success: true });

    } catch (error) {
      console.error('Error clearing unread count:', error);
      return res.status(500).json({ error: 'Failed to clear unread count' });
    }
  }

  return res.status(400).json({ error: 'Invalid action for PATCH request' });
}

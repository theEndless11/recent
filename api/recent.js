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
  let connection;

  try {
    connection = await pool.getConnection();

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
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// Direct database query - ultra-optimized
async function handleGet(req, res, connection, query) {
  const { userId, action } = query;

  if (action === 'get') {
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    try {
      const startTime = Date.now();
      
      // Single lightning-fast query
      const [rows] = await connection.execute(`
  SELECT 
    chat_partner.user_id AS userId,
    chat_partner.user_id AS id,
    COALESCE(rc.chat_username, CONCAT('User ', chat_partner.user_id)) AS username,
    COALESCE(rc.chat_profile_picture, 'default-pfp.jpg') AS profile_picture,
    latest_msg.content AS lastMessage,
    latest_msg.timestamp AS lastSeen,
    COALESCE(unread_count.count, 0) AS unreadCount
  FROM (
    SELECT DISTINCT
      CASE WHEN username = ? THEN chatwith ELSE username END AS user_id
    FROM messages 
    WHERE username = ? OR chatwith = ?
    ORDER BY (
      SELECT MAX(m2.timestamp) FROM messages m2 
      WHERE (m2.username = ? AND m2.chatwith = CASE WHEN username = ? THEN chatwith ELSE username END)
         OR (m2.chatwith = ? AND m2.username = CASE WHEN username = ? THEN chatwith ELSE username END)
    ) DESC
    LIMIT 20
  ) chat_partner

  LEFT JOIN (
    SELECT 
      CASE WHEN username = ? THEN chatwith ELSE username END AS other_user_id,
      content,
      timestamp,
      ROW_NUMBER() OVER (
        PARTITION BY CASE WHEN username = ? THEN chatwith ELSE username END 
        ORDER BY timestamp DESC
      ) as rn
    FROM messages 
    WHERE username = ? OR chatwith = ?
  ) latest_msg 
  ON latest_msg.other_user_id = chat_partner.user_id AND latest_msg.rn = 1

  LEFT JOIN (
    SELECT username, COUNT(*) as count
    FROM messages 
    WHERE chatwith = ? AND is_read = FALSE
    GROUP BY username
  ) unread_count ON unread_count.username = chat_partner.user_id

  LEFT JOIN recent_chats rc 
  ON rc.user_id = ? AND rc.chat_user_id = chat_partner.user_id

  ORDER BY latest_msg.timestamp DESC
`, [
  userId, userId, userId, userId, userId, userId, userId, // chat_partner
  userId, userId, userId, userId,                         // latest_msg
  userId,                                                 // unread_count
  userId                                                  // recent_chats join
]);

      

      const duration = Date.now() - startTime;
      console.log(`Direct query executed in ${duration}ms for user ${userId}`);
      
      const recentChats = rows.map(row => ({
        userId: row.userId,
        id: row.id,
        username: row.username,
        profile_picture: row.profile_picture,
        lastMessage: row.lastMessage || 'Tap to start chatting',
        lastSeen: row.lastSeen,
        unreadCount: row.unreadCount,
        isOnline: false
      }));

      return res.status(200).json({ recentChats });

    } catch (error) {
      console.error('Error fetching recent chats:', error);
      return res.status(500).json({ error: 'Failed to fetch recent chats' });
    }
  }

  return res.status(400).json({ error: 'Invalid action for GET request' });
}

async function handlePost(req, res, connection, body) {
  const { action, updates } = body;

  if (action === 'batchUpdate') {
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array is required' });
    }

    try {
      await connection.beginTransaction();

      const values = [];
      const placeholders = [];

      for (const update of updates) {
        const { userId, chatData } = update;
        if (!userId || !chatData) continue;

        placeholders.push('(?, ?, ?, ?, ?, ?, ?, NOW(), NOW())');
        values.push(
          userId, chatData.userId, chatData.username, chatData.profile_picture,
          chatData.lastMessage, chatData.lastSeen, chatData.unreadCount || 0
        );
      }

      if (placeholders.length > 0) {
        await connection.execute(`
          INSERT INTO recent_chats (
            user_id, chat_user_id, chat_username, chat_profile_picture,
            last_message, last_seen, unread_count, created_at, updated_at
          ) VALUES ${placeholders.join(', ')}
          ON DUPLICATE KEY UPDATE
            chat_username = VALUES(chat_username),
            chat_profile_picture = VALUES(chat_profile_picture),
            last_message = VALUES(last_message),
            last_seen = VALUES(last_seen),
            unread_count = VALUES(unread_count),
            updated_at = NOW()
        `, values);
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

async function handlePatch(req, res, connection, body) {
  const { action, userId, chatUserId } = body;

  if (action === 'clearUnread') {
    if (!userId || !chatUserId) {
      return res.status(400).json({ error: 'userId and chatUserId are required' });
    }

    try {
      const [result] = await connection.execute(`
        UPDATE messages 
        SET is_read = TRUE 
        WHERE sender_id = ? AND receiver_id = ? AND is_read = FALSE
      `, [chatUserId, userId]);

      return res.status(200).json({ 
        success: true, 
        messagesMarkedRead: result.affectedRows 
      });

    } catch (error) {
      console.error('Error clearing unread count:', error);
      return res.status(500).json({ error: 'Failed to clear unread count' });
    }
  }

  return res.status(400).json({ error: 'Invalid action for PATCH request' });
}

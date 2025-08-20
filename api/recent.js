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

// Helper function to sync recent chats with latest messages
async function syncRecentChatsWithMessages(connection, userId) {
  try {
    // Get all unique chat partners for this user from messages table
    const [chatPartners] = await connection.execute(`
      SELECT DISTINCT
        CASE 
          WHEN sender_id = ? THEN receiver_id 
          ELSE sender_id 
        END AS chat_user_id,
        MAX(created_at) as last_message_time
      FROM messages 
      WHERE sender_id = ? OR receiver_id = ?
      GROUP BY chat_user_id
      ORDER BY last_message_time DESC
    `, [userId, userId, userId]);

    for (const partner of chatPartners) {
      // Get the latest message between these two users
      const [latestMessage] = await connection.execute(`
        SELECT 
          message,
          created_at,
          sender_id,
          receiver_id
        FROM messages 
        WHERE (sender_id = ? AND receiver_id = ?) 
           OR (sender_id = ? AND receiver_id = ?)
        ORDER BY created_at DESC 
        LIMIT 1
      `, [userId, partner.chat_user_id, partner.chat_user_id, userId]);

      if (latestMessage.length > 0) {
        const msg = latestMessage[0];
        
        // Get chat partner's username and profile picture
        const [userInfo] = await connection.execute(`
          SELECT username, profile_picture 
          FROM users 
          WHERE id = ?
        `, [partner.chat_user_id]);

        const chatUsername = userInfo[0]?.username || 'Unknown User';
        const chatProfilePicture = userInfo[0]?.profile_picture || 'default-pfp.jpg';

        // Count unread messages (messages sent to current user that they haven't seen)
        const [unreadCount] = await connection.execute(`
          SELECT COUNT(*) as count
          FROM messages 
          WHERE sender_id = ? AND receiver_id = ? AND seen = FALSE
        `, [partner.chat_user_id, userId]);

        // Update or insert recent chat entry
        await connection.execute(`
          INSERT INTO recent_chats (
            user_id, chat_user_id,
            chat_username, chat_profile_picture,
            last_message, last_seen, unread_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            chat_username = VALUES(chat_username),
            chat_profile_picture = VALUES(chat_profile_picture),
            last_message = VALUES(last_message),
            last_seen = VALUES(last_seen),
            unread_count = VALUES(unread_count),
            updated_at = NOW()
        `, [
          userId,
          partner.chat_user_id,
          chatUsername,
          chatProfilePicture,
          msg.message,
          msg.created_at,
          unreadCount[0].count
        ]);
      }
    }

    return true;
  } catch (error) {
    console.error('Error syncing recent chats with messages:', error);
    throw error;
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
      // ✅ First sync recent chats with messages table
      await syncRecentChatsWithMessages(connection, userId);

      // Then fetch the synced recent chats
      const [rows] = await connection.execute(`
        SELECT 
          rc.chat_user_id AS userId,
          rc.chat_user_id AS id,
          rc.chat_username AS username,
          rc.chat_profile_picture AS profile_picture,
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
        username: row.username,
        profile_picture: row.profile_picture || 'default-pfp.jpg',
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

        // ✅ Use localStorage values with fallbacks
        const chatUsername = chatData.username || 'Unknown User';
        const chatProfilePicture = chatData.profile_picture || 'default-pfp.jpg';

        await connection.execute(`
          INSERT INTO recent_chats (
            user_id, chat_user_id,
            chat_username, chat_profile_picture,
            last_message, last_seen, unread_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            chat_username = VALUES(chat_username),
            chat_profile_picture = VALUES(chat_profile_picture),
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
          chatUsername,
          chatProfilePicture,
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
      // ✅ First sync to ensure we have the latest data
      await syncRecentChatsWithMessages(connection, userId);

      // Then clear unread count
      const [result] = await connection.execute(`
        UPDATE recent_chats 
        SET unread_count = 0, updated_at = NOW()
        WHERE user_id = ? AND chat_user_id = ?
      `, [userId, chatUserId]);

      if (result.affectedRows === 0) {
        // Get chat partner info if recent chat doesn't exist
        const [userInfo] = await connection.execute(`
          SELECT username, profile_picture 
          FROM users 
          WHERE id = ?
        `, [chatUserId]);

        const chatUsername = userInfo[0]?.username || 'Unknown User';
        const chatProfilePicture = userInfo[0]?.profile_picture || 'default-pfp.jpg';

        await connection.execute(`
          INSERT INTO recent_chats (
            user_id, chat_user_id,
            chat_username, chat_profile_picture,
            last_message, last_seen, unread_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, NOW(), NOW())
        `, [
          userId,
          chatUserId,
          chatUsername,
          chatProfilePicture,
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

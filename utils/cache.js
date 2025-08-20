// utils/cache.js
const redis = require('redis');

let client;
const CACHE_TTL = 30; // 30 seconds

const initRedis = async () => {
  if (!client) {
    client = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        connectTimeout: 5000,
        lazyConnect: true,
      },
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          return new Error('Redis server refused connection');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          return new Error('Retry time exhausted');
        }
        return Math.min(options.attempt * 100, 3000);
      }
    });

    client.on('error', (err) => console.log('Redis Client Error', err));
    await client.connect();
  }
  return client;
};

const getCachedRecentChats = async (userId) => {
  try {
    const redis = await initRedis();
    const cached = await redis.get(`recent_chats:${userId}`);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.warn('Cache get failed:', error);
    return null;
  }
};

const setCachedRecentChats = async (userId, data) => {
  try {
    const redis = await initRedis();
    await redis.setEx(
      `recent_chats:${userId}`, 
      CACHE_TTL, 
      JSON.stringify(data)
    );
  } catch (error) {
    console.warn('Cache set failed:', error);
  }
};

const invalidateUserCache = async (userId) => {
  try {
    const redis = await initRedis();
    await redis.del(`recent_chats:${userId}`);
  } catch (error) {
    console.warn('Cache invalidation failed:', error);
  }
};

module.exports = {
  getCachedRecentChats,
  setCachedRecentChats,
  invalidateUserCache
};

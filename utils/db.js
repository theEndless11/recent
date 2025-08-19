// utils/db.js

const mysql = require('mysql2/promise');

// Database connection configuration
const dbConfig = {
  host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
  port: 4000,
  user: '3MpxXZ6aU48Rwn2.root',
  password: '73O5MeujubpOyRsD', // Replace with your actual password or use environment variable
  database: 'test',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: true
  }
};

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}

module.exports = getPool();

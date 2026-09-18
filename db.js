require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'muluk_system',
  user: process.env.DB_USER || 'u0_a466',
});

module.exports = pool;

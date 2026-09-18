require('dotenv').config();
const { Pool } = require('pg');

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'muluk_system',
      user: process.env.DB_USER || 'u0_a466',
      password: process.env.DB_PASSWORD || undefined
    };

const pool = new Pool(poolConfig);

module.exports = pool;

const { Pool } = require('pg');
require('dotenv').config();
 
const connectionString = process.env.DATABASE_URL;
let ssl = false;

try {
  const host = new URL(connectionString).hostname;
  // O hostname interno do Render não contém ponto e não usa TLS.
  // Conexões externas usam um domínio completo e exigem TLS.
  ssl = host.includes('.') && host !== 'localhost'
    ? { rejectUnauthorized: false }
    : false;
} catch (_erro) {
  ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
}

const pool = new Pool({
  connectionString,
  ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});
 
module.exports = pool;

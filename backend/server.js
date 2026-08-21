const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const pool = require('./db');
 
const app = express();
app.use(express.json());
app.use(cors());
 
// Rota de cadastro
app.post('/cadastro', async (req, res) => {
  const { nome, email, senha, telefone } = req.body;
  const senhaHash = await bcrypt.hash(senha, 10);
 
  const [result] = await pool.query(
    'INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)',
    [nome, email, senhaHash]
  );
  await pool.query(
    'INSERT INTO clientes (usuario_id, telefone) VALUES (?, ?)',
    [result.insertId, telefone]
  );
 
  res.json({ sucesso: true });
});
 
// Rota de login
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
 
  if (rows.length === 0) return res.json({ sucesso: false });
 
  const senhaCorreta = await bcrypt.compare(senha, rows[0].senha_hash);
  res.json({ sucesso: senhaCorreta });
});
 
app.listen(3000, () => console.log('Servidor rodando na porta 3000'));
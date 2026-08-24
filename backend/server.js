const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const pool = require('./db');
 
const app = express();
app.use(express.json());
app.use(cors());
 
// Rota de cadastro
app.post('/api/cadastro', async (req, res) => {
  const { nome, email, senha, telefone } = req.body;
  const senhaHash = await bcrypt.hash(senha, 10);
 
  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id',
      [nome, email, senhaHash]
    );
    const usuarioId = result.rows[0].id;
 
    await pool.query(
      'INSERT INTO clientes (usuario_id, telefone) VALUES ($1, $2)',
      [usuarioId, telefone]
    );
 
    res.json({ sucesso: true });
  } catch (erro) {
    console.error(erro);
    res.json({ sucesso: false, erro: 'Não foi possível criar a conta.' });
  }
});
 
// Rota de login
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
 
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
 
    if (result.rows.length === 0) return res.json({ sucesso: false });
 
    const senhaCorreta = await bcrypt.compare(senha, result.rows[0].senha_hash);
    res.json({ sucesso: senhaCorreta });
  } catch (erro) {
    console.error(erro);
    res.json({ sucesso: false });
  }
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
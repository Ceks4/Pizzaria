const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { MercadoPagoConfig, Payment } = require('mercadopago');
 
const app = express();
app.use(express.json());
app.use(cors());
 
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
 
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
    const result = await pool.query(
      `SELECT u.*, r.nome as papel
       FROM usuarios u
       JOIN roles r ON u.role_id = r.id
       WHERE u.email = $1`,
      [email]
    );
 
    if (result.rows.length === 0) return res.json({ sucesso: false });
 
    const senhaCorreta = await bcrypt.compare(senha, result.rows[0].senha_hash);
    res.json({
      sucesso: senhaCorreta,
      nome: senhaCorreta ? result.rows[0].nome : null,
      papel: senhaCorreta ? result.rows[0].papel : null
    });
  } catch (erro) {
    console.error(erro);
    res.json({ sucesso: false });
  }
});
 
// Rota para gerar o Pix (Mercado Pago)
app.post('/api/pagamento-pix', async (req, res) => {
  const { valor, descricao, email } = req.body;
 
  try {
    const payment = new Payment(client);
    const resultado = await payment.create({
      body: {
        transaction_amount: valor,
        description: descricao,
        payment_method_id: 'pix',
        payer: { email: email }
      }
    });
 
    res.json({
      id: resultado.id,
      qrCodeBase64: 'data:image/png;base64,' + resultado.point_of_interaction.transaction_data.qr_code_base64,
      codigoCopiaCola: resultado.point_of_interaction.transaction_data.qr_code
    });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Erro ao gerar Pix' });
  }
});
 
// Rota para checar status do pagamento
app.get('/api/pagamento-status/:id', async (req, res) => {
  try {
    const payment = new Payment(client);
    const resultado = await payment.get({ id: req.params.id });
    res.json({ status: resultado.status });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Erro ao checar status' });
  }
});
 
// Criar pedido (chamado depois que o Pix é aprovado)
app.post('/api/pedidos', async (req, res) => {
  const { email, nome, itens, total, endereco } = req.body;
 
  try {
    await pool.query(
      `INSERT INTO pedidos (cliente_nome, cliente_email, itens, endereco, total)
       VALUES ($1, $2, $3, $4, $5)`,
      [nome, email, JSON.stringify(itens), JSON.stringify(endereco), total]
    );
 
    res.json({ sucesso: true });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Não foi possível salvar o pedido.' });
  }
});
 
// Listar pedidos do cliente logado
app.get('/api/pedidos/cliente', async (req, res) => {
  const { email } = req.query;
 
  try {
    const resultado = await pool.query(
      `SELECT id, itens, total, endereco, status, criado_em
       FROM pedidos
       WHERE cliente_email = $1
       ORDER BY criado_em DESC`,
      [email]
    );
 
    res.json({ pedidos: resultado.rows });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Não foi possível consultar os pedidos.' });
  }
});
 
// Cancelar pedido (só se ainda estiver em preparação)
app.patch('/api/pedidos/cliente/:id/cancelar', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
 
  try {
    const resultado = await pool.query(
      `UPDATE pedidos
       SET status = 'cancelado'
       WHERE id = $1 AND cliente_email = $2 AND status = 'em_preparacao'
       RETURNING id`,
      [id, email]
    );
 
    if (resultado.rows.length === 0) {
      return res.status(400).json({ erro: 'Pedido não encontrado ou não pode mais ser cancelado.' });
    }
 
    res.json({ sucesso: true });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Não foi possível cancelar o pedido.' });
  }
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
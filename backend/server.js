const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
require('dotenv').config();
const pool = require('./db');
const { MercadoPagoConfig, Payment } = require('mercadopago');
 
const app = express();
app.use(express.json());
app.use(cors());
 
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const client = MP_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN }) : null;
 
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

  if (!client) {
    return res.status(503).json({ erro: 'Pagamento temporariamente indisponível.' });
  }

  try {
    const payment = new Payment(client);
    const resultado = await payment.create({
      body: {
        transaction_amount: Number(valor),
        description: descricao || 'Pedido LosPizzanitos',
        payment_method_id: 'pix',
        payer: { email: email || '' }
      }
    });

    const qrCodeBase64 = resultado?.point_of_interaction?.transaction_data?.qr_code_base64;
    const qrCode = resultado?.point_of_interaction?.transaction_data?.qr_code;

    if (!qrCodeBase64 || !qrCode) {
      return res.status(502).json({ erro: 'Não foi possível gerar o QR Code do Pix.' });
    }

    res.json({
      id: resultado.id,
      qrCodeBase64: 'data:image/png;base64,' + qrCodeBase64,
      codigoCopiaCola: qrCode
    });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Erro ao gerar Pix' });
  }
});
 
// Rota para checar status do pagamento
app.get('/api/pagamento-status/:id', async (req, res) => {
  if (!client) {
    return res.status(503).json({ erro: 'Pagamento temporariamente indisponível.' });
  }

  try {
    const payment = new Payment(client);
    const resultado = await payment.get({ id: req.params.id });
    res.json({ status: resultado.status }); // approved, pending, rejected
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Erro ao checar status' });
  }
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
require('dotenv').config();
const pool = require('./db');
 
const app = express();
app.use(express.json());
app.use(cors());

const ADMIN_USUARIO = process.env.ADMIN_USUARIO || 'Senzalitos';
const ADMIN_SENHA = process.env.ADMIN_SENHA || 'Africanos';
const ABACATEPAY_API_URL = 'https://api.abacatepay.com/v2/billing/create';
const sessoesAdmin = new Set();

async function prepararTabelaPedidos() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente_nome VARCHAR(150) NOT NULL,
      cliente_email VARCHAR(150),
      itens JSONB NOT NULL,
      endereco JSONB NOT NULL,
      total NUMERIC(10, 2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'em_preparacao',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'em_preparacao'");
}

function exigirAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessoesAdmin.has(token)) {
    return res.status(401).json({ sucesso: false, erro: 'Acesso não autorizado.' });
  }
  next();
}
 
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
      `SELECT u.id, u.nome, u.email, c.telefone, u.senha_hash
       FROM usuarios u
       LEFT JOIN clientes c ON c.usuario_id = u.id
       WHERE u.email = $1`,
      [email]
    );
 
    if (result.rows.length === 0) return res.json({ sucesso: false });
 
    const usuario = result.rows[0];
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);

    if (!senhaCorreta) return res.json({ sucesso: false });

    res.json({
      sucesso: true,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        telefone: usuario.telefone
      }
    });
  } catch (erro) {
    console.error(erro);
    res.json({ sucesso: false });
  }
});

// Login exclusivo do painel administrativo
app.post('/api/admin/login', (req, res) => {
  const { usuario, senha } = req.body;
  if (usuario !== ADMIN_USUARIO || senha !== ADMIN_SENHA) {
    return res.status(401).json({ sucesso: false, erro: 'Usuário ou senha inválidos.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessoesAdmin.add(token);
  res.json({ sucesso: true, token });
});

// Cria o checkout no servidor para manter a chave da Abacate Pay protegida.
app.post('/api/pagamentos', async (req, res) => {
  const { nome, email, telefone, itens, total } = req.body;
  const valorTotal = Number(total);

  if (!nome || !email || !Array.isArray(itens) || itens.length === 0 || !Number.isFinite(valorTotal) || valorTotal <= 0) {
    return res.status(400).json({ sucesso: false, erro: 'Dados do pagamento incompletos.' });
  }

  if (!process.env.ABACATEPAY_API_KEY) {
    return res.status(503).json({ sucesso: false, erro: 'Pagamento temporariamente indisponível.' });
  }

  const produtos = itens.map((item, indice) => ({
    externalId: String(item.id || `pizza-${indice + 1}`),
    name: String(item.nome || 'Item do pedido'),
    description: 'Pedido LosPizzanitos',
    quantity: Math.max(1, Number(item.quantidade) || 1),
    price: Math.round((Number(item.preco) || 0) * 100)
  }));

  try {
    const resposta = await fetch(ABACATEPAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ABACATEPAY_API_KEY}`
      },
      body: JSON.stringify({
        frequency: 'ONE_TIME',
        methods: ['PIX'],
        products: produtos,
        returnUrl: process.env.ABACATEPAY_RETURN_URL || 'https://pizzaria-asml.github.io/Pizzaria/finalizar.html',
        completionUrl: process.env.ABACATEPAY_COMPLETION_URL || 'https://pizzaria-asml.github.io/Pizzaria/finalizar.html?pagamento=sucesso',
        customer: {
          name: String(nome),
          email: String(email),
          cellphone: telefone ? String(telefone) : undefined
        }
      })
    });
    const dados = await resposta.json();

    if (!resposta.ok || !dados?.data?.checkoutUrl) {
      console.error('Falha ao criar cobrança Abacate Pay:', dados);
      return res.status(502).json({ sucesso: false, erro: 'Não foi possível iniciar o pagamento.' });
    }

    res.json({ sucesso: true, checkoutUrl: dados.data.checkoutUrl });
  } catch (erro) {
    console.error('Erro ao conectar com a Abacate Pay:', erro);
    res.status(502).json({ sucesso: false, erro: 'Não foi possível conectar ao pagamento.' });
  }
});

// Registra o pedido confirmado para consulta no painel
app.post('/api/pedidos', async (req, res) => {
  const { nome, email, itens, endereco, total } = req.body;
  if (!nome || !Array.isArray(itens) || itens.length === 0 || !endereco || !Number.isFinite(Number(total))) {
    return res.status(400).json({ sucesso: false, erro: 'Dados do pedido incompletos.' });
  }

  try {
    const resultado = await pool.query(
      `INSERT INTO pedidos (cliente_nome, cliente_email, itens, endereco, total)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5) RETURNING id`,
      [nome, email || null, JSON.stringify(itens), JSON.stringify(endereco), Number(total)]
    );
    res.status(201).json({ sucesso: true, pedidoId: resultado.rows[0].id });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ sucesso: false, erro: 'Não foi possível registrar o pedido.' });
  }
});

// Consulta todos os pedidos do cliente pelo e-mail da conta
app.get('/api/pedidos/cliente', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ sucesso: false, erro: 'E-mail do cliente não informado.' });
  }

  try {
    const resultado = await pool.query(
      `SELECT id, cliente_nome, itens, endereco, total, status, criado_em
       FROM pedidos WHERE LOWER(cliente_email) = $1 ORDER BY criado_em DESC`,
      [email]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ sucesso: false, erro: 'Nenhum pedido encontrado para esta conta.' });
    }
    res.json({ sucesso: true, pedidos: resultado.rows });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ sucesso: false, erro: 'Não foi possível consultar o pedido.' });
  }
});

// Permite ao cliente cancelar o próprio pedido enquanto ele ainda está em preparação
app.patch('/api/pedidos/cliente/:id/cancelar', async (req, res) => {
  const pedidoId = Number(req.params.id);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!Number.isInteger(pedidoId) || pedidoId < 1 || !email) {
    return res.status(400).json({ sucesso: false, erro: 'Dados para cancelamento inválidos.' });
  }

  try {
    const resultado = await pool.query(
      `UPDATE pedidos SET status = 'cancelado'
       WHERE id = $1 AND LOWER(cliente_email) = $2 AND status = 'em_preparacao'
       RETURNING id, status`,
      [pedidoId, email]
    );
    if (resultado.rows.length === 0) {
      return res.status(409).json({ sucesso: false, erro: 'Este pedido não pode mais ser cancelado.' });
    }
    res.json({ sucesso: true, pedido: resultado.rows[0] });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ sucesso: false, erro: 'Não foi possível cancelar o pedido.' });
  }
});

// Consulta pública do status pelo número do pedido
app.get('/api/pedidos/:id', async (req, res) => {
  const pedidoId = Number(req.params.id);
  if (!Number.isInteger(pedidoId) || pedidoId < 1) {
    return res.status(400).json({ sucesso: false, erro: 'Número de pedido inválido.' });
  }

  try {
    const resultado = await pool.query(
      'SELECT id, cliente_nome, itens, endereco, total, status, criado_em FROM pedidos WHERE id = $1',
      [pedidoId]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ sucesso: false, erro: 'Pedido não encontrado.' });
    }
    res.json({ sucesso: true, pedido: resultado.rows[0] });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ sucesso: false, erro: 'Não foi possível consultar o pedido.' });
  }
});

// Lista pedidos somente para usuários autenticados no painel
app.get('/api/admin/pedidos', exigirAdmin, async (req, res) => {
  try {
    const resultado = await pool.query('SELECT id, cliente_nome, cliente_email, itens, endereco, total, status, criado_em FROM pedidos ORDER BY criado_em DESC');
    res.json({ sucesso: true, pedidos: resultado.rows });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ sucesso: false, erro: 'Não foi possível carregar os pedidos.' });
  }
});

app.patch('/api/admin/pedidos/:id/status', exigirAdmin, async (req, res) => {
  const pedidoId = Number(req.params.id);
  const statusPermitidos = ['em_preparacao', 'saiu_para_entrega', 'concluido', 'cancelado'];
  const { status } = req.body;
  if (!Number.isInteger(pedidoId) || !statusPermitidos.includes(status)) {
    return res.status(400).json({ sucesso: false, erro: 'Status inválido.' });
  }

  try {
    const resultado = await pool.query(
      'UPDATE pedidos SET status = $1 WHERE id = $2 RETURNING id, status',
      [status, pedidoId]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ sucesso: false, erro: 'Pedido não encontrado.' });
    }
    res.json({ sucesso: true, pedido: resultado.rows[0] });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ sucesso: false, erro: 'Não foi possível atualizar o status.' });
  }
});
 
const PORT = process.env.PORT || 3000;
prepararTabelaPedidos()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(erro => {
    console.error('Não foi possível preparar o banco de dados:', erro);
    process.exit(1);
  });
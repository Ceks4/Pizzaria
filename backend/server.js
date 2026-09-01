const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { MercadoPagoConfig, Payment } = require('mercadopago');
 
const app = express();
app.use(express.json());
app.use(cors());
 
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

const ADMIN_DEFAULT = {
  usuario: process.env.ADMIN_USER || 'admin',
  senha: process.env.ADMIN_PASS || 'admin123'
};
const adminTokens = new Set();

function parseJsonField(valor) {
  if (!valor) return valor;
  if (typeof valor === 'string') {
    try {
      return JSON.parse(valor);
    } catch (_erro) {
      return valor;
    }
  }
  return valor;
}

function autenticarAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  next();
}

async function validarCredenciaisAdmin(usuario, senha) {
  if (usuario === ADMIN_DEFAULT.usuario && senha === ADMIN_DEFAULT.senha) {
    return true;
  }

  try {
    const resultado = await pool.query(
      `SELECT u.senha_hash
       FROM usuarios u
       JOIN roles r ON u.role_id = r.id
       WHERE (u.nome = $1 OR u.email = $1) AND r.nome = 'admin'
       LIMIT 1`,
      [usuario]
    );

    if (resultado.rows.length === 0) return false;
    return bcrypt.compare(senha, resultado.rows[0].senha_hash);
  } catch (erro) {
    console.error('Erro ao validar admin no banco:', erro);
    return false;
  }
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
 
// Login do painel administrativo
app.post('/api/admin/login', async (req, res) => {
  const { usuario, senha } = req.body || {};

  if (!usuario || !senha) {
    return res.status(400).json({ erro: 'Usuário e senha são obrigatórios.' });
  }

  const valido = await validarCredenciaisAdmin(usuario, senha);
  if (!valido) {
    return res.status(401).json({ erro: 'Credenciais inválidas.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);

  return res.json({ token });
});

app.get('/api/admin/pedidos', autenticarAdmin, async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT id, cliente_nome, cliente_email, itens, endereco, total, status, criado_em
       FROM pedidos
       ORDER BY criado_em DESC`
    );

    const pedidos = resultado.rows.map(pedido => ({
      ...pedido,
      itens: parseJsonField(pedido.itens),
      endereco: parseJsonField(pedido.endereco)
    }));

    return res.json({ pedidos });
  } catch (erro) {
    console.error(erro);
    return res.status(500).json({ erro: 'Não foi possível consultar os pedidos.' });
  }
});

app.patch('/api/admin/pedidos/:id/status', autenticarAdmin, async (req, res) => {
  const { status } = req.body || {};
  const statusPermitidos = ['em_preparacao', 'saiu_para_entrega', 'concluido', 'cancelado'];

  if (!statusPermitidos.includes(status)) {
    return res.status(400).json({ erro: 'Status inválido.' });
  }

  try {
    const resultado = await pool.query(
      `UPDATE pedidos
       SET status = $1
       WHERE id = $2
       RETURNING id`,
      [status, req.params.id]
    );

    if (resultado.rowCount === 0) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    return res.json({ sucesso: true });
  } catch (erro) {
    console.error(erro);
    return res.status(500).json({ erro: 'Não foi possível atualizar o status.' });
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
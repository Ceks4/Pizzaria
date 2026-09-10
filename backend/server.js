const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { MercadoPagoConfig, Payment, PaymentRefund } = require('mercadopago');
 
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors());
 
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

function credenciaisMercadoPagoConfiguradas() {
  return Boolean(process.env.MP_ACCESS_TOKEN && process.env.MP_PUBLIC_KEY);
}

function normalizarValor(valor, minimo = 0.01) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < minimo) return null;

  const arredondado = Math.round((numero + Number.EPSILON) * 100) / 100;
  return Math.abs(numero - arredondado) < Number.EPSILON * 10 ? arredondado : null;
}

function extrairErroMercadoPago(erro) {
  const causa = Array.isArray(erro?.cause) ? erro.cause[0] : erro?.cause;
  return causa?.description || causa?.message || erro?.message || null;
}

function textoPagamento(valor, limite = 120) {
  return typeof valor === 'string' ? valor.trim().slice(0, limite) : '';
}

function montarDadosAntifraude(req, order) {
  const nomeCompleto = textoPagamento(order?.buyer_name, 120);
  const partesNome = nomeCompleto.split(/\s+/).filter(Boolean);
  const firstName = partesNome.shift() || '';
  const lastName = partesNome.join(' ');
  const endereco = order?.address || {};
  const streetName = textoPagamento(endereco.endereco, 120);
  const streetNumber = textoPagamento(endereco.numero, 20);
  const zipCode = textoPagamento(endereco.cep, 12).replace(/[^0-9]/g, '');

  const items = Array.isArray(order?.items)
    ? order.items.slice(0, 50).map((item, indice) => {
        const quantity = Math.max(1, Math.min(99, Math.trunc(Number(item?.quantity) || 1)));
        const unitPrice = normalizarValor(item?.unit_price, 0.01);
        const title = textoPagamento(item?.title, 120);
        if (!unitPrice || !title) return null;

        return {
          id: textoPagamento(String(item?.id ?? indice), 50),
          title,
          description: title,
          category_id: 'food',
          quantity,
          currency_id: 'BRL',
          unit_price: unitPrice,
          type: 'physical'
        };
      }).filter(Boolean)
    : [];

  const payer = {
    ...(firstName ? { first_name: firstName } : {}),
    ...(lastName ? { last_name: lastName } : {}),
    ...(streetName || zipCode ? {
      address: {
        ...(zipCode ? { zip_code: zipCode } : {}),
        ...(streetName ? { street_name: streetName } : {}),
        ...(streetNumber ? { street_number: streetNumber } : {})
      }
    } : {})
  };

  return {
    ...(req.ip ? { ip_address: req.ip.replace(/^::ffff:/, '') } : {}),
    ...(items.length ? { items } : {}),
    ...(Object.keys(payer).length ? { payer } : {})
  };
}

const ADMIN_DEFAULT = {
  usuario: process.env.ADMIN_USER || 'admin',
  senha: process.env.ADMIN_PASS || 'admin123'
};
const adminTokens = new Set();

async function garantirColunasPedidos() {
  try {
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagamento_id TEXT`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS teste BOOLEAN NOT NULL DEFAULT FALSE`);
  } catch (erro) {
    console.error('Erro ao garantir coluna motivo_cancelamento:', erro);
  }
}

const guardarColunasPedido = garantirColunasPedidos();

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

async function reembolsarPagamento(pagamentoId) {
  if (!pagamentoId) {
    throw new Error('Este pedido não possui um pagamento vinculado para estorno.');
  }

  const refund = new PaymentRefund(client);
  return refund.total({ payment_id: pagamentoId });
}

function tokenAdminDaRequisicao(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function adminAutorizado(req) {
  const token = tokenAdminDaRequisicao(req);
  return Boolean(token && adminTokens.has(token));
}

function autenticarAdmin(req, res, next) {
  const token = tokenAdminDaRequisicao(req);

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

app.get('/api/admin/resumo', autenticarAdmin, async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT
         COUNT(*)::int AS total_pedidos,
         COALESCE(SUM(CASE WHEN status <> 'cancelado' AND teste = FALSE THEN total ELSE 0 END), 0)::numeric AS faturamento,
         COUNT(*) FILTER (WHERE status = 'cancelado' AND teste = FALSE)::int AS pedidos_cancelados,
         COUNT(*) FILTER (WHERE status IN ('em_preparacao', 'saiu_para_entrega') AND teste = FALSE)::int AS pedidos_em_andamento,
         COUNT(*) FILTER (WHERE teste = TRUE)::int AS pedidos_teste
       FROM pedidos`
    );

    const resumo = resultado.rows[0];
    return res.json({
      total_pedidos: Number(resumo.total_pedidos),
      faturamento: Number(resumo.faturamento || 0),
      pedidos_cancelados: Number(resumo.pedidos_cancelados),
      pedidos_em_andamento: Number(resumo.pedidos_em_andamento),
      pedidos_teste: Number(resumo.pedidos_teste)
    });
  } catch (erro) {
    console.error(erro);
    return res.status(500).json({ erro: 'Não foi possível consultar o resumo.' });
  }
});

app.get('/api/admin/pedidos', autenticarAdmin, async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT id, cliente_nome, cliente_email, itens, endereco, total, status, motivo_cancelamento, pagamento_id, teste, criado_em
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
  const { status, motivo_cancelamento } = req.body || {};
  const statusPermitidos = ['em_preparacao', 'saiu_para_entrega', 'concluido', 'cancelado'];

  if (!statusPermitidos.includes(status)) {
    return res.status(400).json({ erro: 'Status inválido.' });
  }

  try {
    const motivo = typeof motivo_cancelamento === 'string' ? motivo_cancelamento.trim() : '';
    if (status === 'cancelado' && !motivo) {
      return res.status(400).json({ erro: 'Informe o motivo do cancelamento.' });
    }

    if (status === 'cancelado') {
      const pedido = await pool.query(
        `SELECT pagamento_id FROM pedidos WHERE id = $1 AND status <> 'cancelado'`,
        [req.params.id]
      );

      if (pedido.rows.length === 0) {
        return res.status(404).json({ erro: 'Pedido não encontrado.' });
      }

      await reembolsarPagamento(pedido.rows[0].pagamento_id);
    }

    const resultado = await pool.query(
      status === 'cancelado'
        ? `UPDATE pedidos
           SET status = $1, motivo_cancelamento = $2
           WHERE id = $3
           RETURNING id`
        : `UPDATE pedidos
           SET status = $1, motivo_cancelamento = NULL
           WHERE id = $2
           RETURNING id`,
      status === 'cancelado' ? [status, motivo, req.params.id] : [status, req.params.id]
    );

    if (resultado.rowCount === 0) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    return res.json({ sucesso: true, reembolso: status === 'cancelado' });
  } catch (erro) {
    console.error(erro);
    return res.status(502).json({ erro: erro.message || 'Não foi possível atualizar o status.' });
  }
});

// Rota para gerar o Pix (Mercado Pago)
app.post('/api/pagamento-pix', async (req, res) => {
  const { valor, descricao, email, modo_teste } = req.body;
  const modoTesteAutorizado = Boolean(modo_teste && adminAutorizado(req));
  const valorNormalizado = modoTesteAutorizado ? 5 : normalizarValor(valor);

  if (modo_teste && !modoTesteAutorizado) {
    return res.status(403).json({ erro: 'O modo de teste precisa ser iniciado pelo painel administrativo.' });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(503).json({ erro: 'O pagamento ainda não está configurado no servidor.' });
  }

  if (valorNormalizado === null || !email) {
    return res.status(400).json({ erro: 'Valor ou e-mail inválido para gerar o Pix.' });
  }
 
  try {
    const payment = new Payment(client);
    const resultado = await payment.create({
      body: {
        transaction_amount: valorNormalizado,
        description: descricao,
        payment_method_id: 'pix',
        payer: { email: email }
      },
      requestOptions: { idempotencyKey: crypto.randomUUID() }
    });
 
    res.json({
      id: resultado.id,
      qrCodeBase64: 'data:image/png;base64,' + resultado.point_of_interaction.transaction_data.qr_code_base64,
      codigoCopiaCola: resultado.point_of_interaction.transaction_data.qr_code
    });
  } catch (erro) {
    console.error(erro);
    res.status(502).json({ erro: extrairErroMercadoPago(erro) || 'Erro ao gerar Pix.' });
  }
});

app.get('/api/pagamento-config', (_req, res) => {
  if (!credenciaisMercadoPagoConfiguradas()) {
    return res.status(503).json({ erro: 'As credenciais do Mercado Pago não estão completas.' });
  }

  return res.json({ publicKey: process.env.MP_PUBLIC_KEY });
});

// Processa o token do cartão gerado pelo Payment Brick do Mercado Pago
app.post('/api/pagamento-cartao', async (req, res) => {
  const {
    transaction_amount,
    token,
    description,
    installments,
    payment_method_id,
    issuer_id,
    payer,
    device_id,
    order,
    modo_teste
  } = req.body || {};
  const modoTesteAutorizado = Boolean(modo_teste && adminAutorizado(req));
  const valor = modoTesteAutorizado ? 5 : normalizarValor(transaction_amount, 1);
  const documentoBruto = payer?.identification?.number;
  const documento = textoPagamento(documentoBruto == null ? '' : String(documentoBruto), 20).replace(/\D/g, '');
  const deviceId = textoPagamento(device_id, 255);

  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(503).json({ erro: 'O pagamento ainda não está configurado no servidor.' });
  }

  if (modo_teste && !modoTesteAutorizado) {
    return res.status(403).json({ erro: 'O modo de teste precisa ser iniciado pelo painel administrativo.' });
  }

  if (valor === null || !token || !payment_method_id || !payer?.email) {
    return res.status(400).json({ erro: 'Dados do pagamento incompletos.' });
  }

  if (![11, 14].includes(documento.length)) {
    return res.status(400).json({ erro: 'Informe um CPF válido para processar o pagamento.' });
  }


  const totalItens = Array.isArray(order?.items)
    ? order.items.reduce((soma, item) => soma + (Number(item?.unit_price) || 0) * (Number(item?.quantity) || 0), 0)
    : 0;

  if (!modoTesteAutorizado && Math.abs(totalItens - valor) > 0.009) {
    return res.status(400).json({ erro: 'O valor do pagamento não corresponde ao total do carrinho.' });
  }

  try {
    const payment = new Payment(client);
    const orderPagamento = modoTesteAutorizado
      ? { ...order, items: [{ id: 'teste-admin', title: 'Pedido de teste administrativo', quantity: 1, unit_price: 5 }] }
      : order;
    const dadosAntifraude = montarDadosAntifraude(req, orderPagamento);
    const nomeComprador = dadosAntifraude.payer || {};
    const resultado = await payment.create({
      body: {
        transaction_amount: valor,
        token,
        description: description || 'Pedido LosPizzanitos',
        installments: Number(installments) || 1,
        payment_method_id,
        ...(issuer_id ? { issuer_id } : {}),
        payer: {
          email: payer.email,
          identification: {
            type: textoPagamento(payer.identification.type, 10) || (documento.length === 11 ? 'CPF' : 'CNPJ'),
            number: documento
          },
          ...(nomeComprador.first_name ? { first_name: nomeComprador.first_name } : {}),
          ...(nomeComprador.last_name ? { last_name: nomeComprador.last_name } : {}),
          ...(nomeComprador.address ? { address: nomeComprador.address } : {})
        },
        ...(Object.keys(dadosAntifraude).length ? { additional_info: dadosAntifraude } : {})
      },
      requestOptions: {
        idempotencyKey: crypto.randomUUID(),
        ...(deviceId ? { meliSessionId: deviceId } : {})
      }
    });

    if (resultado.status !== 'approved') {
      console.warn('Pagamento não aprovado pelo Mercado Pago', {
        id: resultado.id,
        status: resultado.status,
        detalhe: resultado.status_detail,
        deviceIdEnviado: Boolean(deviceId),
        cpfEnviado: true,
        itensEnviados: dadosAntifraude.items?.length || 0,
        modoTeste: modoTesteAutorizado
      });
    }

    return res.json({ id: resultado.id, status: resultado.status, detalhe: resultado.status_detail });
  } catch (erro) {
    console.error(erro);
    const detalhe = extrairErroMercadoPago(erro);
    return res.status(502).json({
      erro: detalhe || 'Não foi possível processar o cartão. Confira os dados e tente novamente.'
    });
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
  const { email, nome, itens, total, endereco, pagamento_id, modo_teste } = req.body;
  const modoTesteAutorizado = Boolean(modo_teste && adminAutorizado(req));

  if (modo_teste && !modoTesteAutorizado) {
    return res.status(403).json({ erro: 'Pedido de teste não autorizado.' });
  }
 
  try {
    const resultado = await pool.query(
      `INSERT INTO pedidos (cliente_nome, cliente_email, itens, endereco, total, pagamento_id, teste)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [nome, email, JSON.stringify(itens), JSON.stringify(endereco), modoTesteAutorizado ? 5 : total, pagamento_id || null, modoTesteAutorizado]
    );
 
    res.json({ sucesso: true, pedidoId: resultado.rows[0].id });
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
      `SELECT id, itens, total, endereco, status, motivo_cancelamento, teste, criado_em
       FROM pedidos
       WHERE cliente_email = $1
       ORDER BY criado_em DESC`,
      [email]
    );
 
    const pedidos = resultado.rows.map(pedido => ({
      ...pedido,
      motivo_cancelamento: pedido.motivo_cancelamento || null,
      itens: parseJsonField(pedido.itens),
      endereco: parseJsonField(pedido.endereco)
    }));

    res.json({ pedidos });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Não foi possível consultar os pedidos.' });
  }
});
 
// Cancelar pedido (só se ainda estiver em preparação)
app.patch('/api/pedidos/cliente/:id/cancelar', async (req, res) => {
  const { id } = req.params;
  const { email, motivo_cancelamento, motivo } = req.body || {};
  const motivoTexto = (motivo_cancelamento || motivo || '').toString().trim();
 
  if (!motivoTexto) {
    return res.status(400).json({ erro: 'Informe o motivo do cancelamento.' });
  }
 
  try {
    const pedido = await pool.query(
      `SELECT pagamento_id FROM pedidos
       WHERE id = $1 AND cliente_email = $2 AND status = 'em_preparacao'`,
      [id, email]
    );

    if (pedido.rows.length === 0) {
      return res.status(400).json({ erro: 'Pedido não encontrado ou não pode mais ser cancelado.' });
    }

    await reembolsarPagamento(pedido.rows[0].pagamento_id);

    const resultado = await pool.query(
      `UPDATE pedidos
       SET status = 'cancelado', motivo_cancelamento = $3
       WHERE id = $1 AND cliente_email = $2 AND status = 'em_preparacao'
       RETURNING id, motivo_cancelamento`,
      [id, email, motivoTexto]
    );

    if (resultado.rows.length === 0) {
      return res.status(409).json({ erro: 'O pedido mudou de status enquanto o estorno era processado.' });
    }
 
    res.json({ sucesso: true, reembolso: true, motivo_cancelamento: resultado.rows[0].motivo_cancelamento });
  } catch (erro) {
    console.error(erro);
    res.status(502).json({ erro: erro.message || 'Não foi possível cancelar o pedido.' });
  }
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

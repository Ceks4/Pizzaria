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

const FOTOS_PRODUTOS = [
  ['mussarela', 'Mussarela', 'https://www.milanpizzaria.com.br/assets/mussarela-Bnv6-EQb.jpg', 'https://www.milanpizzaria.com.br/', 'Milan Pizzaria'],
  ['calabresa', 'Calabresa', 'https://duisktnou8b89.cloudfront.net/img/items/692715419eb51.jpeg', 'https://deliverydireto.com.br/mammaspizza/mammaspizza', 'Mammas Pizza'],
  ['portuguesa', 'Portuguesa', 'https://deliverypostoauto7.com.br/media/produtos/_dsc8976_portuguesa.jpg', 'https://deliverypostoauto7.com.br/produto/828/pizza-de-portuguesa', 'Posto Auto 7'],
  ['frango-com-catupiry', 'Frango com Catupiry', 'https://www.arise-app.com/images/dishes/pt/fatia-de-pizza-de-frango-com-catupiry-e-milho-1c6s9s.webp', 'https://www.arise-app.com/pt/prato/Fatia-de-Pizza-de-Frango-com-Catupiry-e-Milho', 'Arise'],
  ['quatro-queijos', 'Quatro Queijos', 'https://images.bolt.eu/store/2024/2024-08-01/40c4c29a-2a5c-4473-bab5-7adfed4faf7f.jpeg', 'https://food.bolt.eu/', 'Pizza Day / Bolt Food'],
  ['marguerita', 'Marguerita', 'https://itsonly.recipes/images/recipeimages/traditional-margherita-pizza.webp', 'https://itsonly.recipes/view/traditional-margherita-pizza', 'ItsOnly Recipes'],
  ['napolitana', 'Napolitana', 'https://d22fxaf9t8d39k.cloudfront.net/3159e0fe61e3847a667a4fed5928f2da792a96584c070e4bfaf80b444231afab56506.jpg', 'https://www.siamobrato.com.ar/pizzas-congeladas/napolitana-2u', 'Siamo Brato'],
  ['toscana', 'Toscana', 'https://cdn.thefork.com/tf-lab/image/upload/f_auto%2Cq_auto%2Cg_auto%3Asubject%2Cw_488%2Ch_488%2Cc_fill/customer/b474e32a-7216-4767-a843-e609d716b80c/cc362190-3daa-44b8-a2af-5d0d84909465.jpg', 'https://www.thefork.it/ristorante/aria-pizza-ad-libitum-r748620', 'Aria Pizza / TheFork'],
  ['bacon', 'Bacon', 'https://delicity.b-cdn.net/upload/2026_02_18/oNwTpLyAapadSQcA_base.jpeg', 'https://casapepi.fr/', 'Casa Pepi'],
  ['milho-com-bacon', 'Milho com Bacon', 'https://cms-bomgourmet.s3.amazonaws.com/bomgourmet/2025/08/19150922/foto2_baixa_abarepizzaria_prato_foto_by_Marcelo_Krelling-682x1024.png', 'https://bomgourmet.com/sem-categoria/saiba-qual-a-melhor-pizzaria-de-curitiba-premio-bom-gourmet/', 'Marcelo Krelling / Bom Gourmet'],
  ['atum', 'Atum', 'https://cdn.website.dish.co/media/fb/da/8350910/Pizzeria-grill-Oliva-Al-tono-jpg.jpg', 'https://pizzeria-grill-oliva.eatbu.com/', 'Pizzeria Grill Oliva'],
  ['vegetariana', 'Vegetariana', 'https://static.addiyar.com/storage/attachments/1791/d7796a4e7229fca90f5cfaa2ad5f83e8_w750_h750_680476_large.jpg', 'https://addiyar.com/article/1790395', 'Addiyar'],
  ['pepperoni', 'Pepperoni', 'https://images.pexels.com/photos/5903315/pexels-photo-5903315.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/search/pepperoni%20pizza/', 'Roman Odintsov / Pexels'],
  ['costela-com-barbecue', 'Costela com Barbecue', 'https://images.mrcook.app/recipe-image/01988d47-8b08-7698-bf12-a91201eff8aa?cacheKey=U2F0LCAwOSBBdWcgMjAyNSAwNToyMjoxNSBHTVQ%3D', 'https://www.mrcook.app/pt-BR/recipes/01988d47-8b08-7698-bf12-a91201eff8aa', 'Mr. Cook'],
  ['camarao-ao-catupiry', 'Camarão ao Catupiry', 'https://images.multipedidos.com.br/highlightImages/b1968e44944cc05e2da187797110abb16ef3ab549da2053415f379d6d56f776d/lg_b1968e44944cc05e2da187797110abb16ef3ab549da2053415f379d6d56f776d.jpg', 'https://pedir.delivery/app/dnapolli/menu', 'D Napolli Pizzaria'],
  ['parma-com-rucula', 'Parma com Rúcula', 'https://152031577.cdn6.editmysite.com/uploads/1/5/2/0/152031577/NFKRPXUNJJKR2J45M4HMVWZ2.jpeg', 'https://www.365woodfiredpizzas.com/product/margherita-al-prosciutto-di-parma/64', '365 Woodfired Pizza'],
  ['carne-seca-com-abobora', 'Carne Seca com Abóbora', 'https://midias.correiobraziliense.com.br/_midias/jpg/2025/05/28/image_123650291__2_-52921388.jpg', 'https://www.correiobraziliense.com.br/revista-do-correio/2025/06/7158982-pizza-em-familia-o-sucesso-da-pizzaria-sesconnettos-no-df.html', 'Correio Braziliense'],
  ['lombo-com-cheddar', 'Lombo com Cheddar', 'https://static.wixstatic.com/media/c236a1_32695f7120254dc4962edcc31818fce7~mv2.jpg', 'https://www.kingpizza.com.br/cardapio', 'KingPizza'],
  ['chocolate-com-morango', 'Chocolate com Morango', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-chocolate-morango.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['brigadeiro', 'Brigadeiro', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-brigadeiro.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['banana-com-canela', 'Banana com Canela', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-banana-canela.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['prestigio', 'Prestígio', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-prestigio.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['refrigerante-2l', 'Refrigerante 2L', 'https://images.pexels.com/photos/14373170/pexels-photo-14373170.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/search/soda%20bottle/', 'Beyza Yurtkuran / Pexels'],
  ['refrigerante-lata', 'Refrigerante lata', 'https://images.pexels.com/photos/5860659/pexels-photo-5860659.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/search/soda%20can/', 'Gustavo Santana / Pexels'],
  ['suco-natural', 'Suco natural', 'https://images.pexels.com/photos/14510445/pexels-photo-14510445.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/search/orange%20juice/', 'Rae Wallis / Pexels'],
  ['agua-mineral', 'Água mineral', 'https://images.pexels.com/photos/31699476/pexels-photo-31699476.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/search/water%20bottle/', 'Jaralol / Pexels'],
  ['cerveja-long-neck', 'Cerveja long neck', 'https://images.pexels.com/photos/5537952/pexels-photo-5537952.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/search/beer%20bottle/', 'Cottonbro Studio / Pexels']
].map(([slug, nome, url, fonte_url, credito]) => ({ slug, nome, url, fonte_url, credito }));

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

async function garantirFotosProdutos() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fotos_produtos (
      slug TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      url TEXT NOT NULL,
      fonte_url TEXT NOT NULL,
      credito TEXT NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    `INSERT INTO fotos_produtos (slug, nome, url, fonte_url, credito)
     SELECT slug, nome, url, fonte_url, credito
     FROM jsonb_to_recordset($1::jsonb)
       AS foto(slug TEXT, nome TEXT, url TEXT, fonte_url TEXT, credito TEXT)
     ON CONFLICT (slug) DO UPDATE SET
       nome = EXCLUDED.nome,
       url = EXCLUDED.url,
       fonte_url = EXCLUDED.fonte_url,
       credito = EXCLUDED.credito,
       atualizado_em = NOW()`,
    [JSON.stringify(FOTOS_PRODUTOS)]
  );
}

const guardarFotosProdutos = garantirFotosProdutos().catch(erro => {
  console.error('Erro ao preparar fotos dos produtos:', erro);
  throw erro;
});

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
app.get('/api/fotos-produtos', async (_req, res) => {
  try {
    await guardarFotosProdutos;
    const resultado = await pool.query(
      `SELECT slug, nome, url, fonte_url, credito, atualizado_em
       FROM fotos_produtos
       ORDER BY nome`
    );
    res.set('Cache-Control', 'public, max-age=900, stale-while-revalidate=86400');
    return res.json({ fotos: resultado.rows });
  } catch (erro) {
    console.error('Erro ao listar fotos dos produtos:', erro);
    return res.status(500).json({ erro: 'Não foi possível carregar as fotos do cardápio.' });
  }
});

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
         COUNT(*) FILTER (WHERE teste = FALSE)::int AS total_pedidos,
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
  const { valor, descricao, email } = req.body;
  const valorNormalizado = normalizarValor(valor);

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
    order
  } = req.body || {};
  const valor = normalizarValor(transaction_amount, 1);
  const documentoBruto = payer?.identification?.number;
  const documento = textoPagamento(documentoBruto == null ? '' : String(documentoBruto), 20).replace(/\D/g, '');
  const deviceId = textoPagamento(device_id, 255);

  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(503).json({ erro: 'O pagamento ainda não está configurado no servidor.' });
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

  if (Math.abs(totalItens - valor) > 0.009) {
    return res.status(400).json({ erro: 'O valor do pagamento não corresponde ao total do carrinho.' });
  }

  try {
    const payment = new Payment(client);
    const dadosAntifraude = montarDadosAntifraude(req, order);
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
        emailTeste: payer.email.trim().toLowerCase() === 'test@testuser.com'
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
  const { email, nome, itens, total, endereco, pagamento_id } = req.body;
 
  try {
    const resultado = await pool.query(
      `INSERT INTO pedidos (cliente_nome, cliente_email, itens, endereco, total, pagamento_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [nome, email, JSON.stringify(itens), JSON.stringify(endereco), total, pagamento_id || null]
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

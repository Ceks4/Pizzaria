const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { MercadoPagoConfig, Payment, PaymentRefund } = require('mercadopago');
 
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
const origensPermitidas = new Set([
  'https://ceks4.github.io',
  'https://pizzaria-asml.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || origensPermitidas.has(origin) || /^https:\/\/[a-z0-9-]+\.(app\.github\.dev|githubpreview\.dev)$/.test(origin)) return callback(null, true);
    return callback(new Error('Origem não permitida.'));
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
}));
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  });
  next();
});
 
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

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

const ADMIN_DEFAULT = {
  usuario: process.env.ADMIN_USER || '',
  senha: process.env.ADMIN_PASS || ''
};
const adminTokens = new Map();
const tentativas = new Map();

function limitarRequisicoes({ janelaMs = 60_000, maximo = 20 } = {}) {
  return (req, res, next) => {
    const chave = `${req.ip}:${req.path}`;
    const agora = Date.now();
    const registro = tentativas.get(chave);
    if (!registro || agora > registro.expiraEm) {
      tentativas.set(chave, { quantidade: 1, expiraEm: agora + janelaMs });
      return next();
    }
    registro.quantidade += 1;
    if (registro.quantidade > maximo) {
      res.set('Retry-After', String(Math.ceil((registro.expiraEm - agora) / 1000)));
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco e tente novamente.' });
    }
    return next();
  };
}

const limiteLogin = limitarRequisicoes({ janelaMs: 15 * 60_000, maximo: 10 });
const limitePedido = limitarRequisicoes({ janelaMs: 60_000, maximo: 12 });

const FOTOS_PRODUTOS = [
  ['mussarela', 'Mussarela', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-mussarela.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['calabresa', 'Calabresa', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-calabresa.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['portuguesa', 'Portuguesa', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-portuguesa.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['frango-com-catupiry', 'Frango com Catupiry', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-frango-com-catupiry.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['quatro-queijos', 'Quatro Queijos', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-quatro-queijos.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['marguerita', 'Marguerita', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-marguerita.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['napolitana', 'Napolitana', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-napolitana.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['toscana', 'Toscana', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-toscana.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['bacon', 'Bacon', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-bacon.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['milho-com-bacon', 'Milho com Bacon', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-milho-com-bacon.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['atum', 'Atum', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-atum.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['vegetariana', 'Vegetariana', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-vegetariana.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['pepperoni', 'Pepperoni', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-pepperoni.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['costela-com-barbecue', 'Costela com Barbecue', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-costela-com-barbecue.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['camarao-ao-catupiry', 'Camarão ao Catupiry', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-camarao-ao-catupiry.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['parma-com-rucula', 'Parma com Rúcula', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-parma-com-rucula.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['carne-seca-com-abobora', 'Carne Seca com Abóbora', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-carne-seca-com-abobora.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['lombo-com-cheddar', 'Lombo com Cheddar', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-lombo-com-cheddar.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['chocolate-com-morango', 'Chocolate com Morango', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-chocolate-morango.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['brigadeiro', 'Brigadeiro', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-brigadeiro.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['banana-com-canela', 'Banana com Canela', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-banana-canela.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['prestigio', 'Prestígio', 'https://ceks4.github.io/Pizzaria/assets/menu/pizza-prestigio.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['refrigerante-2l', 'Refrigerante 2L', 'https://ceks4.github.io/Pizzaria/assets/menu/bebida-refrigerante-2l.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['refrigerante-lata', 'Refrigerante lata', 'https://ceks4.github.io/Pizzaria/assets/menu/bebida-refrigerante-lata.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['suco-natural', 'Suco natural', 'https://ceks4.github.io/Pizzaria/assets/menu/bebida-suco-natural.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['agua-mineral', 'Água mineral', 'https://ceks4.github.io/Pizzaria/assets/menu/bebida-agua-mineral.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos'],
  ['cerveja-long-neck', 'Cerveja long neck', 'https://ceks4.github.io/Pizzaria/assets/menu/bebida-cerveja-long-neck.jpg', 'https://ceks4.github.io/Pizzaria/', 'Imagem criada para Los Pizzanitos']
].map(([slug, nome, url, fonte_url, credito]) => ({ slug, nome, url, fonte_url, credito }));

const CATALOGO = new Map([
  ['mussarela', 50], ['calabresa', 52], ['portuguesa', 58], ['frango com catupiry', 59],
  ['quatro queijos', 61], ['marguerita', 55], ['napolitana', 54], ['toscana', 57],
  ['bacon', 58], ['milho com bacon', 57], ['atum', 60], ['vegetariana', 56],
  ['pepperoni', 65], ['costela com barbecue', 72], ['camarao ao catupiry', 84],
  ['parma com rucula', 79], ['carne seca com abobora', 74], ['lombo com cheddar', 68],
  ['chocolate com morango', 58], ['brigadeiro', 54], ['banana com canela', 50], ['prestigio', 56],
  ['refrigerante 2l', 14], ['refrigerante lata', 6], ['suco natural', 12], ['agua mineral', 5],
  ['cerveja long neck', 11]
]);
const BEBIDAS = new Set(['refrigerante 2l', 'refrigerante lata', 'suco natural', 'agua mineral', 'cerveja long neck']);
const TAMANHOS = {
  broto: { fator: 0.5, rotulo: 'Broto · 4 fatias' },
  media: { fator: 0.75, rotulo: 'Média · 6 fatias' },
  grande: { fator: 1, rotulo: 'Grande · 8 fatias' }
};
const CONFIG_ENTREGA_PADRAO = {
  ativo: true,
  cidade: 'São Paulo',
  estado: 'SP',
  dias: [0, 2, 3, 4, 5, 6],
  abertura: '18:00',
  fechamento: '23:30',
  zonas: [
    { nome: 'Região próxima', cep_inicio: '01000000', cep_fim: '01999999', taxa: 5, prazo_min: 40, prazo_max: 55 },
    { nome: 'Região intermediária', cep_inicio: '02000000', cep_fim: '03999999', taxa: 10, prazo_min: 45, prazo_max: 65 },
    { nome: 'Região limite', cep_inicio: '04000000', cep_fim: '05999999', taxa: 15, prazo_min: 55, prazo_max: 75 }
  ]
};

function normalizarTexto(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function textoSeguro(valor, limite = 160) {
  return typeof valor === 'string' ? valor.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limite) : '';
}

function normalizarItens(itens) {
  if (!Array.isArray(itens) || itens.length < 1 || itens.length > 50) throw new Error('Carrinho inválido.');
  return itens.map(item => {
    const quantidade = Math.trunc(Number(item?.quantidade));
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 20) throw new Error('Quantidade inválida no carrinho.');
    const nomeInformado = textoSeguro(item?.nome, 140).split(' — ')[0];
    const chave = normalizarTexto(nomeInformado);
    const precoGrande = CATALOGO.get(chave);
    if (!precoGrande) throw new Error(`Produto inválido: ${nomeInformado || 'sem nome'}.`);
    const bebida = BEBIDAS.has(chave);
    let tamanho = null;
    if (!bebida) {
      const informado = normalizarTexto(item?.tamanho || item?.nome);
      tamanho = Object.keys(TAMANHOS).find(opcao => informado.includes(opcao)) || null;
      if (!tamanho) throw new Error(`Escolha um tamanho válido para ${nomeInformado}.`);
    }
    const dadosTamanho = tamanho ? TAMANHOS[tamanho] : { fator: 1, rotulo: null };
    const preco = Number((precoGrande * dadosTamanho.fator).toFixed(2));
    const nome = dadosTamanho.rotulo ? `${nomeInformado} — ${dadosTamanho.rotulo}` : nomeInformado;
    return { id: `${chave.replace(/\s+/g, '-')}${tamanho ? `-${tamanho}` : ''}`, nome, preco, quantidade, tamanho: dadosTamanho.rotulo };
  });
}

function subtotalDosItens(itens) {
  return Number(itens.reduce((soma, item) => soma + item.preco * item.quantidade, 0).toFixed(2));
}

async function garantirColunasPedidos() {
  try {
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagamento_id TEXT`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS teste BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS forma_pagamento TEXT`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS troco_para NUMERIC(10, 2)`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cliente_id INTEGER REFERENCES usuarios(id)`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10, 2)`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS taxa_entrega NUMERIC(10, 2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS prazo_estimado TEXT`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo_cartao TEXT`);
    await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS chave_idempotencia TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS pedidos_chave_idempotencia_idx ON pedidos(chave_idempotencia) WHERE chave_idempotencia IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS pedidos_cliente_id_idx ON pedidos(cliente_id, criado_em DESC)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sessoes_token_idx ON sessoes(token)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamentos_pendentes (
        pagamento_id TEXT PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        total NUMERIC(10, 2) NOT NULL,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuracoes_app (
        chave TEXT PRIMARY KEY,
        valor JSONB NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `INSERT INTO configuracoes_app (chave, valor) VALUES ('entrega', $1::jsonb) ON CONFLICT (chave) DO NOTHING`,
      [JSON.stringify(CONFIG_ENTREGA_PADRAO)]
    );
  } catch (erro) {
    console.error('Erro ao preparar estrutura do banco:', erro);
    throw erro;
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
  if (!pagamentoId) return false;

  const refund = new PaymentRefund(client);
  await refund.total({ payment_id: pagamentoId });
  return true;
}

function tokenAdminDaRequisicao(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function criarSessao(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  await pool.query(`DELETE FROM sessoes WHERE expira_em < NOW()`);
  await pool.query(
    `INSERT INTO sessoes (usuario_id, token, expira_em) VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [usuarioId, tokenHash]
  );
  return token;
}

async function autenticarUsuario(req, res, next) {
  const token = tokenAdminDaRequisicao(req);
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return res.status(401).json({ erro: 'Faça login novamente.' });
  try {
    const resultado = await pool.query(
      `SELECT u.id, u.nome, u.email, r.nome AS papel, c.telefone
       FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN clientes c ON c.usuario_id = u.id
       WHERE s.token = $1 AND s.expira_em > NOW() AND u.ativo = TRUE
       LIMIT 1`,
      [hashToken(token)]
    );
    if (!resultado.rows.length) return res.status(401).json({ erro: 'Sua sessão expirou. Entre novamente.' });
    req.usuario = resultado.rows[0];
    return next();
  } catch (erro) {
    console.error('Erro de autenticação:', erro);
    return res.status(500).json({ erro: 'Não foi possível validar sua sessão.' });
  }
}

function autenticarAdmin(req, res, next) {
  const token = tokenAdminDaRequisicao(req);

  if (!token || !adminTokens.has(token) || adminTokens.get(token) < Date.now()) {
    if (token) adminTokens.delete(token);
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  next();
}

async function validarCredenciaisAdmin(usuario, senha) {
  if (ADMIN_DEFAULT.usuario && ADMIN_DEFAULT.senha && usuario === ADMIN_DEFAULT.usuario && senha === ADMIN_DEFAULT.senha) {
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

async function obterConfigEntrega() {
  await guardarColunasPedido;
  const resultado = await pool.query(`SELECT valor FROM configuracoes_app WHERE chave = 'entrega' LIMIT 1`);
  return resultado.rows[0]?.valor || CONFIG_ENTREGA_PADRAO;
}

function horarioSaoPaulo() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const mapa = Object.fromEntries(partes.map(parte => [parte.type, parte.value]));
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dia: dias[mapa.weekday], minutos: Number(mapa.hour) * 60 + Number(mapa.minute) };
}

function minutosHorario(valor) {
  const [hora, minuto] = String(valor || '').split(':').map(Number);
  return hora * 60 + minuto;
}

async function calcularEntrega(endereco, ignorarHorario = false) {
  const config = await obterConfigEntrega();
  if (!config.ativo) throw new Error('As entregas estão temporariamente pausadas.');
  const cep = String(endereco?.cep || '').replace(/\D/g, '');
  const cidade = normalizarTexto(endereco?.cidade);
  const estado = textoSeguro(endereco?.estado, 2).toUpperCase();
  if (cep.length !== 8 || cidade !== normalizarTexto(config.cidade) || estado !== String(config.estado).toUpperCase()) {
    throw new Error(`No momento entregamos somente em ${config.cidade}/${config.estado}.`);
  }
  const zona = (config.zonas || []).find(item => cep >= String(item.cep_inicio) && cep <= String(item.cep_fim));
  if (!zona) throw new Error('Este CEP está fora da nossa área de entrega.');
  const agora = horarioSaoPaulo();
  const aberto = (config.dias || []).includes(agora.dia) && agora.minutos >= minutosHorario(config.abertura) && agora.minutos <= minutosHorario(config.fechamento);
  if (!ignorarHorario && !aberto) throw new Error(`Estamos fechados. Pedidos: ${config.abertura} às ${config.fechamento}.`);
  return {
    zona: textoSeguro(zona.nome, 80),
    taxa: Number(zona.taxa),
    prazo_min: Number(zona.prazo_min),
    prazo_max: Number(zona.prazo_max),
    prazo: `${Number(zona.prazo_min)}–${Number(zona.prazo_max)} min`,
    aberto,
    horario: `${config.abertura} às ${config.fechamento}`
  };
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

app.post('/api/cadastro', limiteLogin, async (req, res) => {
  const nome = textoSeguro(req.body?.nome, 100);
  const email = textoSeguro(req.body?.email, 160).toLowerCase();
  const senha = String(req.body?.senha || '');
  const telefone = textoSeguro(req.body?.telefone, 20);
  if (nome.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || senha.length < 8 || senha.length > 72 || telefone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ erro: 'Confira nome, e-mail, telefone e use uma senha com pelo menos 8 caracteres.' });
  }
  const senhaHash = await bcrypt.hash(senha, 12);
  const conexao = await pool.connect();
  try {
    await conexao.query('BEGIN');
    const result = await conexao.query(
      'INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id',
      [nome, email, senhaHash]
    );
    const usuarioId = result.rows[0].id;
    await conexao.query(
      'INSERT INTO clientes (usuario_id, telefone) VALUES ($1, $2)',
      [usuarioId, telefone]
    );
    await conexao.query('COMMIT');
    return res.status(201).json({ sucesso: true });
  } catch (erro) {
    await conexao.query('ROLLBACK');
    if (erro.code === '23505') return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
    console.error('Erro ao cadastrar:', erro);
    return res.status(500).json({ erro: 'Não foi possível criar a conta.' });
  } finally {
    conexao.release();
  }
});
 
// Rota de login
app.post('/api/login', limiteLogin, async (req, res) => {
  const email = textoSeguro(req.body?.email, 160).toLowerCase();
  const senha = String(req.body?.senha || '');
  if (!email || !senha) return res.status(400).json({ erro: 'Informe e-mail e senha.' });
 
  try {
    const result = await pool.query(
      `SELECT u.*, r.nome as papel
       FROM usuarios u
       JOIN roles r ON u.role_id = r.id
       WHERE u.email = $1`,
      [email]
    );
 
    if (result.rows.length === 0) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
 
    const senhaCorreta = await bcrypt.compare(senha, result.rows[0].senha_hash);
    if (!senhaCorreta) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    const token = await criarSessao(result.rows[0].id);
    return res.json({ sucesso: true, token, usuario: { nome: result.rows[0].nome, email: result.rows[0].email, papel: result.rows[0].papel } });
  } catch (erro) {
    console.error('Erro no login:', erro);
    return res.status(500).json({ erro: 'Não foi possível entrar agora.' });
  }
});

app.post('/api/logout', autenticarUsuario, async (req, res) => {
  await pool.query(`DELETE FROM sessoes WHERE token = $1`, [hashToken(tokenAdminDaRequisicao(req))]);
  return res.json({ sucesso: true });
});

app.get('/api/entrega/config', async (_req, res) => {
  try {
    const config = await obterConfigEntrega();
    const agora = horarioSaoPaulo();
    const aberto = config.ativo && config.dias.includes(agora.dia) && agora.minutos >= minutosHorario(config.abertura) && agora.minutos <= minutosHorario(config.fechamento);
    return res.json({ cidade: config.cidade, estado: config.estado, abertura: config.abertura, fechamento: config.fechamento, dias: config.dias, aberto });
  } catch (_erro) { return res.status(500).json({ erro: 'Não foi possível consultar o horário.' }); }
});

app.post('/api/entrega/calcular', autenticarUsuario, limitePedido, async (req, res) => {
  try { return res.json(await calcularEntrega(req.body?.endereco)); }
  catch (erro) { return res.status(400).json({ erro: erro.message }); }
});
 
// Login do painel administrativo
app.post('/api/admin/login', limiteLogin, async (req, res) => {
  const { usuario, senha } = req.body || {};

  if (!usuario || !senha) {
    return res.status(400).json({ erro: 'Usuário e senha são obrigatórios.' });
  }

  const valido = await validarCredenciaisAdmin(usuario, senha);
  if (!valido) {
    return res.status(401).json({ erro: 'Credenciais inválidas.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, Date.now() + 8 * 60 * 60_000);

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
      `SELECT id, cliente_nome, cliente_email, itens, endereco, subtotal, taxa_entrega, total, status, motivo_cancelamento, pagamento_id, forma_pagamento, troco_para, pago, tipo_cartao, prazo_estimado, teste, criado_em
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

app.get('/api/admin/config-entrega', autenticarAdmin, async (_req, res) => {
  try { return res.json({ config: await obterConfigEntrega() }); }
  catch (_erro) { return res.status(500).json({ erro: 'Não foi possível carregar as regras de entrega.' }); }
});

app.put('/api/admin/config-entrega', autenticarAdmin, async (req, res) => {
  const config = req.body?.config;
  try {
    if (!config || !textoSeguro(config.cidade, 80) || !/^[A-Z]{2}$/.test(String(config.estado || '').toUpperCase())) throw new Error('Cidade ou estado inválido.');
    if (!/^\d{2}:\d{2}$/.test(config.abertura) || !/^\d{2}:\d{2}$/.test(config.fechamento)) throw new Error('Horário inválido.');
    if (!Array.isArray(config.dias) || !config.dias.every(dia => Number.isInteger(Number(dia)) && Number(dia) >= 0 && Number(dia) <= 6)) throw new Error('Dias de funcionamento inválidos.');
    if (!Array.isArray(config.zonas) || !config.zonas.length || config.zonas.length > 30) throw new Error('Cadastre pelo menos uma região de entrega.');
    const zonas = config.zonas.map(zona => {
      const inicio = String(zona.cep_inicio || '').replace(/\D/g, '');
      const fim = String(zona.cep_fim || '').replace(/\D/g, '');
      const taxa = Number(zona.taxa), prazoMin = Number(zona.prazo_min), prazoMax = Number(zona.prazo_max);
      if (inicio.length !== 8 || fim.length !== 8 || inicio > fim || !Number.isFinite(taxa) || taxa < 0 || prazoMin < 10 || prazoMax < prazoMin) throw new Error(`Região inválida: ${zona.nome || 'sem nome'}.`);
      return { nome: textoSeguro(zona.nome, 80), cep_inicio: inicio, cep_fim: fim, taxa: Number(taxa.toFixed(2)), prazo_min: Math.trunc(prazoMin), prazo_max: Math.trunc(prazoMax) };
    });
    const normalizada = { ativo: config.ativo !== false, cidade: textoSeguro(config.cidade, 80), estado: String(config.estado).toUpperCase(), dias: [...new Set(config.dias.map(Number))], abertura: config.abertura, fechamento: config.fechamento, zonas };
    await pool.query(`INSERT INTO configuracoes_app (chave, valor, atualizado_em) VALUES ('entrega', $1::jsonb, NOW()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`, [JSON.stringify(normalizada)]);
    return res.json({ sucesso: true, config: normalizada });
  } catch (erro) { return res.status(400).json({ erro: erro.message || 'Configuração inválida.' }); }
});

app.patch('/api/admin/pedidos/:id/pagamento', autenticarAdmin, async (req, res) => {
  const pago = req.body?.pago === true;
  try {
    const resultado = await pool.query(`UPDATE pedidos SET pago = $1 WHERE id = $2 RETURNING id, pago`, [pago, req.params.id]);
    if (!resultado.rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    return res.json({ sucesso: true, pedido: resultado.rows[0] });
  } catch (_erro) { return res.status(500).json({ erro: 'Não foi possível atualizar o pagamento.' }); }
});

app.patch('/api/admin/pedidos/:id/status', autenticarAdmin, async (req, res) => {
  const { status, motivo_cancelamento } = req.body || {};
  const statusPermitidos = ['em_preparacao', 'saiu_para_entrega', 'concluido', 'cancelado'];

  if (!statusPermitidos.includes(status)) {
    return res.status(400).json({ erro: 'Status inválido.' });
  }

  try {
    let reembolsoRealizado = false;
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

      reembolsoRealizado = await reembolsarPagamento(pedido.rows[0].pagamento_id);
    }

    const resultado = await pool.query(
      status === 'cancelado'
        ? `UPDATE pedidos
           SET status = $1, motivo_cancelamento = $2, pago = CASE WHEN $4 THEN FALSE ELSE pago END
           WHERE id = $3
           RETURNING id`
        : `UPDATE pedidos
           SET status = $1, motivo_cancelamento = NULL
           WHERE id = $2
           RETURNING id`,
      status === 'cancelado' ? [status, motivo, req.params.id, reembolsoRealizado] : [status, req.params.id]
    );

    if (resultado.rowCount === 0) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    return res.json({ sucesso: true, reembolso: reembolsoRealizado });
  } catch (erro) {
    console.error(erro);
    return res.status(502).json({ erro: erro.message || 'Não foi possível atualizar o status.' });
  }
});

app.post('/api/pagamento-pix', autenticarUsuario, limitePedido, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN) return res.status(503).json({ erro: 'O Pix ainda não está configurado.' });
  try {
    const itens = normalizarItens(req.body?.itens);
    const entrega = await calcularEntrega(req.body?.endereco);
    const total = Number((subtotalDosItens(itens) + entrega.taxa).toFixed(2));
    const payment = new Payment(client);
    const resultado = await payment.create({
      body: { transaction_amount: total, description: 'Pedido LosPizzanitos', payment_method_id: 'pix', payer: { email: req.usuario.email } },
      requestOptions: { idempotencyKey: crypto.randomUUID() }
    });
    await pool.query(`INSERT INTO pagamentos_pendentes (pagamento_id, usuario_id, total) VALUES ($1, $2, $3)`, [String(resultado.id), req.usuario.id, total]);
    return res.json({ id: resultado.id, total, qrCodeBase64: `data:image/png;base64,${resultado.point_of_interaction.transaction_data.qr_code_base64}`, codigoCopiaCola: resultado.point_of_interaction.transaction_data.qr_code });
  } catch (erro) {
    console.error('Erro ao gerar Pix:', erro);
    return res.status(400).json({ erro: extrairErroMercadoPago(erro) || erro.message || 'Erro ao gerar Pix.' });
  }
});

app.get('/api/pagamento-status/:id', autenticarUsuario, limitePedido, async (req, res) => {
  try {
    const pertence = await pool.query(`SELECT 1 FROM pagamentos_pendentes WHERE pagamento_id = $1 AND usuario_id = $2`, [req.params.id, req.usuario.id]);
    if (!pertence.rows.length) return res.status(404).json({ erro: 'Pagamento não encontrado.' });
    const resultado = await new Payment(client).get({ id: req.params.id });
    return res.json({ status: resultado.status });
  } catch (erro) {
    console.error('Erro ao checar Pix:', erro);
    return res.status(502).json({ erro: 'Não foi possível checar o Pix.' });
  }
});

app.post('/api/pedidos', autenticarUsuario, limitePedido, async (req, res) => {
  const forma = req.body?.forma_pagamento;
  if (!['pix', 'cartao_entrega', 'dinheiro'].includes(forma)) return res.status(400).json({ erro: 'Forma de pagamento inválida.' });
  try {
    const itens = normalizarItens(req.body?.itens);
    const endereco = {
      cep: textoSeguro(req.body?.endereco?.cep, 9), endereco: textoSeguro(req.body?.endereco?.endereco, 140),
      numero: textoSeguro(req.body?.endereco?.numero, 20), complemento: textoSeguro(req.body?.endereco?.complemento, 80),
      bairro: textoSeguro(req.body?.endereco?.bairro, 100), cidade: textoSeguro(req.body?.endereco?.cidade, 80), estado: textoSeguro(req.body?.endereco?.estado, 2).toUpperCase()
    };
    if (!endereco.endereco || !endereco.numero || !endereco.bairro) throw new Error('Endereço incompleto.');
    const entrega = await calcularEntrega(endereco, forma === 'pix');
    const subtotal = subtotalDosItens(itens);
    const total = Number((subtotal + entrega.taxa).toFixed(2));
    const pagamentoId = textoSeguro(req.body?.pagamento_id, 80) || null;
    let pago = false;
    if (forma === 'pix') {
      if (!pagamentoId) throw new Error('Pagamento Pix não informado.');
      const pendente = await pool.query(`SELECT total FROM pagamentos_pendentes WHERE pagamento_id = $1 AND usuario_id = $2`, [pagamentoId, req.usuario.id]);
      if (!pendente.rows.length || Math.abs(Number(pendente.rows[0].total) - total) > 0.009) throw new Error('O valor do Pix não corresponde ao pedido.');
      const pagamento = await new Payment(client).get({ id: pagamentoId });
      if (pagamento.status !== 'approved' || Math.abs(Number(pagamento.transaction_amount) - total) > 0.009) throw new Error('O Pix ainda não foi aprovado.');
      pago = true;
    }
    const troco = forma === 'dinheiro' && req.body?.troco_para != null ? Number(req.body.troco_para) : null;
    if (troco !== null && (!Number.isFinite(troco) || troco < total)) throw new Error('O valor informado para troco é inválido.');
    const tipoCartao = forma === 'cartao_entrega' ? textoSeguro(req.body?.tipo_cartao, 10) : null;
    if (forma === 'cartao_entrega' && !['credito', 'debito'].includes(tipoCartao)) throw new Error('Escolha crédito ou débito.');
    const chave = textoSeguro(req.headers['idempotency-key'] || req.body?.chave_idempotencia, 80);
    if (!/^[a-f0-9-]{36}$/i.test(chave)) throw new Error('Não foi possível validar o envio do pedido. Atualize a página.');
    const resultado = await pool.query(
      `INSERT INTO pedidos (cliente_id, cliente_nome, cliente_email, itens, endereco, subtotal, taxa_entrega, total, pagamento_id, forma_pagamento, troco_para, pago, tipo_cartao, prazo_estimado, chave_idempotencia)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [req.usuario.id, req.usuario.nome, req.usuario.email, JSON.stringify(itens), JSON.stringify(endereco), subtotal, entrega.taxa, total, pagamentoId, forma, troco, pago, tipoCartao, entrega.prazo, chave]
    );
    return res.status(201).json({ sucesso: true, pedidoId: resultado.rows[0].id, total, entrega });
  } catch (erro) {
    if (erro.code === '23505') {
      const existente = await pool.query(`SELECT id, total FROM pedidos WHERE chave_idempotencia = $1 AND cliente_id = $2`, [textoSeguro(req.headers['idempotency-key'] || req.body?.chave_idempotencia, 80), req.usuario.id]);
      if (existente.rows.length) return res.json({ sucesso: true, pedidoId: existente.rows[0].id, total: Number(existente.rows[0].total), duplicado: true });
    }
    console.error('Erro ao criar pedido:', erro);
    return res.status(400).json({ erro: erro.message || 'Não foi possível salvar o pedido.' });
  }
});

app.get('/api/pedidos/cliente', autenticarUsuario, async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT id, itens, subtotal, taxa_entrega, total, endereco, status, motivo_cancelamento, forma_pagamento, troco_para, pago, tipo_cartao, prazo_estimado, teste, criado_em
       FROM pedidos WHERE cliente_id = $1 OR (cliente_id IS NULL AND cliente_email = $2) ORDER BY criado_em DESC LIMIT 100`,
      [req.usuario.id, req.usuario.email]
    );
    return res.json({ pedidos: resultado.rows.map(pedido => ({ ...pedido, itens: parseJsonField(pedido.itens), endereco: parseJsonField(pedido.endereco) })) });
  } catch (erro) {
    console.error('Erro ao listar pedidos:', erro);
    return res.status(500).json({ erro: 'Não foi possível consultar os pedidos.' });
  }
});

app.patch('/api/pedidos/cliente/:id/cancelar', autenticarUsuario, limitePedido, async (req, res) => {
  const motivo = textoSeguro(req.body?.motivo_cancelamento || req.body?.motivo, 300);
  if (!motivo) return res.status(400).json({ erro: 'Informe o motivo do cancelamento.' });
  try {
    const pedido = await pool.query(`SELECT pagamento_id FROM pedidos WHERE id = $1 AND (cliente_id = $2 OR (cliente_id IS NULL AND cliente_email = $3)) AND status = 'em_preparacao'`, [req.params.id, req.usuario.id, req.usuario.email]);
    if (!pedido.rows.length) return res.status(400).json({ erro: 'Pedido não encontrado ou não pode mais ser cancelado.' });
    const reembolso = await reembolsarPagamento(pedido.rows[0].pagamento_id);
    const resultado = await pool.query(`UPDATE pedidos SET status = 'cancelado', motivo_cancelamento = $2, pago = CASE WHEN $3 THEN FALSE ELSE pago END WHERE id = $1 AND status = 'em_preparacao' RETURNING id`, [req.params.id, motivo, reembolso]);
    if (!resultado.rows.length) return res.status(409).json({ erro: 'O pedido mudou de status. Atualize a página.' });
    return res.json({ sucesso: true, reembolso });
  } catch (erro) {
    console.error('Erro ao cancelar:', erro);
    return res.status(502).json({ erro: erro.message || 'Não foi possível cancelar o pedido.' });
  }
});
 
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use((_req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
app.use((erro, _req, res, _next) => {
  console.error('Erro não tratado:', erro.message);
  const origemBloqueada = erro.message === 'Origem não permitida.';
  return res.status(origemBloqueada ? 403 : 500).json({ erro: origemBloqueada ? erro.message : 'Erro interno do servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

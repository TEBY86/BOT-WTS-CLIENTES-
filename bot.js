
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode       = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios        = require('axios');
const path         = require('path');
const fs           = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 🔹 Saltar advertencia de ngrok
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', '1');
  next();
});

app.post('/proxy-sheets', async (req, res) => {
  try {
    const { webhookUrl, ...payload } = req.body;
    
    console.log('📤 Proxy a:', webhookUrl);
    console.log('📦 Payload:', JSON.stringify(payload));
    
    const response = await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },  // ← CAMBIADO
      timeout: 20000
    });
    
    console.log('✅ Respuesta:', response.data);
    res.json(response.data);
  } catch (err) {
    console.error('❌ Error proxy:', err.message);
    if (err.response) console.error('Detalle:', err.response.data);
    res.status(500).json({ status: '-1', message: err.message });
  }
});

app.get('/proxy-sheets', async (req, res) => {
  try {
    const { webhookUrl, ...params } = req.query;
    const response = await axios.get(webhookUrl, { 
      params, 
      timeout: 20000,
      headers: { 'Content-Type': 'application/json' }  // ← AGREGADO
    });
    res.json(response.data);
  } catch (err) {
    console.error('❌ Error proxy GET:', err.message);
    res.status(500).json({ status: '-1', message: err.message });
  }
});




//───────────────────────────────
//  STORE GLOBAL DE BOTS
//  bots[botId] = { client, config, status, qrCode, qrDataUrl, sseClients, memory, rateLimit }
// ─────────────────────────────────────────────────────────────────
const bots = {};

// ─────────────────────────────────────────────────────────────────
//  HELPERS DE LOG
// ─────────────────────────────────────────────────────────────────
function log(botId, level, msg) {
  const ts = new Date().toLocaleTimeString('es-PE');
  const badge = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m' };
  const c = badge[level] || badge.INFO;
  console.log(`${c}[${ts}][${level}]\x1b[0m [\x1b[35m${botId}\x1b[0m] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS DE DELAY ANTI-BLOQUEO
// ─────────────────────────────────────────────────────────────────
function randomDelay(min, max, variance = 20) {
  const base    = Math.floor(Math.random() * (max - min + 1)) + min;
  const delta   = Math.floor(base * (variance / 100) * (Math.random() * 2 - 1));
  return (base + delta) * 1000;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────
//  RATE LIMITER POR CONTACTO
// ─────────────────────────────────────────────────────────────────
function checkRateLimit(botId, numero) {
  const bot    = bots[botId];
  const cfg    = bot.config;
  const maxPorHora = parseInt(cfg.SYS_RATE_LIMIT_HORA) || 15;
  const ahora  = Date.now();
  const hora   = 3600000;

  if (!bot.rateLimit[numero]) bot.rateLimit[numero] = [];
  bot.rateLimit[numero] = bot.rateLimit[numero].filter(t => ahora - t < hora);

  if (bot.rateLimit[numero].length >= maxPorHora) return false;
  bot.rateLimit[numero].push(ahora);
  return true;
}

// ─────────────────────────────────────────────────────────────────
//  VERIFICAR HORARIO OPERATIVO
// ─────────────────────────────────────────────────────────────────
function dentroDeHorario(cfg) {
  if (cfg.AB_HORARIO_ACTIVO !== 'SI') return true;

  // Corregir zona horaria inválida
  let tz = cfg.SYS_ZONA_HORARIA || 'America/Lima';
  if (tz.startsWith('GMT')) {
    tz = 'America/Lima';  // fallback seguro
  }

  const ahora = new Date();
  const formatter = new Intl.DateTimeFormat('es-PE', {
    timeZone: tz,
    hour: '2-digit', 
    minute: '2-digit', 
    hour12: false
  });
  
  const horaActual = formatter.format(ahora);
  const inicio = cfg.SYS_HORA_INICIO || '08:00';
  const fin    = cfg.SYS_HORA_FIN    || '22:00';

  return horaActual >= inicio && horaActual <= fin;
}
// ─────────────────────────────────────────────────────────────────
//  OBTENER/REFRESCAR CONFIGURACIÓN DESDE APPS SCRIPT
// ─────────────────────────────────────────────────────────────────
async function obtenerConfigDesdeSheets(botId) {
  const bot = bots[botId];
  if (!bot) return null;

  try {
    const webhookUrl = bot.webhookUrl;
    const token      = bot.token;
    const params     = new URLSearchParams({ action: 'getConfig', token, botId });
    const res        = await axios.get(`${webhookUrl}?${params}`, { timeout: 15000 });
    const data       = res.data;

    if (data.status === '0' && data.configuracion) {
      bot.config       = data.configuracion;
      bot.productos    = data.productos || '';
      bot.conocimiento = data.conocimiento || '';
      log(botId, 'SUCCESS', 'Configuración cargada desde Sheets');
      return bot.config;
    }
  } catch (err) {
    log(botId, 'WARN', `No se pudo cargar config desde Sheets: ${err.message}`);
  }

  return bot.config || {};
}

// ─────────────────────────────────────────────────────────────────
//  NOTIFICAR AL APPS SCRIPT (callback)
// ─────────────────────────────────────────────────────────────────
async function notificarAppsScript(botId, payload) {
  const bot = bots[botId];
  if (!bot || !bot.webhookUrl) return null;

  try {
    const res = await axios.post(bot.webhookUrl, {
      ...payload,
      token: bot.token,
      botId
    }, {
      headers:  { 'Content-Type': 'text/plain' },
      timeout:  20000
    });
    return res.data;
  } catch (err) {
    log(botId, 'WARN', `Callback Apps Script falló: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
//  SSE — broadcast QR/estado a clientes del panel
// ─────────────────────────────────────────────────────────────────
function sseEmit(botId, event, data) {
  const bot = bots[botId];
  if (!bot || !bot.sseClients) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  bot.sseClients.forEach(res => {
    try { res.write(payload); } catch (_) {}
  });
}

// ─────────────────────────────────────────────────────────────────
//  CREAR E INICIALIZAR UN BOT
// ─────────────────────────────────────────────────────────────────
async function crearBot(botId, webhookUrl, token, configInicial = {}) {
  if (bots[botId]) {
    log(botId, 'WARN', 'Bot ya existe — reiniciando cliente');
    await destruirBot(botId);
  }

  log(botId, 'INFO', `Inicializando bot... Webhook: ${webhookUrl}`);

  bots[botId] = {
    client:      null,
    webhookUrl:  webhookUrl,
    token:       token,
    config:      { ...defaultConfig(), ...configInicial },
    productos:   configInicial.__PRODUCTOS__ || '',
    conocimiento:configInicial.__CONOCIMIENTO__ || '',
    status:      'INICIANDO',
    qrCode:      null,
    qrDataUrl:   null,
    qrPngPath:   null,
    sseClients:  [],
    memory:      {},      // historial conversacional por número
    rateLimit:   {},      // conteo mensajes por número
    lastActivity:{},      // último mensaje por número
    msgCount:    {},      // mensajes seguidos por número
  };

  const sesionDir = path.join(__dirname, '.wwebjs_auth', botId);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: botId, dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: {
      headless:         true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
  });

  bots[botId].client = client;

  // ── EVENTO: QR generado ────────────────────────────────────────
  client.on('qr', async (qr) => {
    log(botId, 'INFO', 'QR generado — escanea con WhatsApp');
    qrcodeTerminal.generate(qr, { small: true });

    bots[botId].qrCode    = qr;
    bots[botId].status    = 'QR_PENDIENTE';

    // Generar data URL para página web
    const dataUrl = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
    bots[botId].qrDataUrl = dataUrl;

    // Guardar QR como PNG
    const pngPath = path.join(__dirname, 'public', `qr_${botId}.png`);
    await qrcode.toFile(pngPath, qr, { width: 300, margin: 2 });
    bots[botId].qrPngPath = pngPath;

    // SSE → panel
    sseEmit(botId, 'qr', {
      botId,
      qr,
      qrDataUrl: dataUrl,
      qrUrl:     `${PUBLIC_URL}/qr/${botId}`,
      qrPngUrl:  `${PUBLIC_URL}/qr/${botId}/png`
    });

    // Notificar Apps Script (guarda QR en la hoja)
    await notificarAppsScript(botId, { op: 'qr', qr });
  });

  // ── EVENTO: Autenticado ────────────────────────────────────────
  client.on('authenticated', () => {
    log(botId, 'SUCCESS', 'Autenticado correctamente');
    bots[botId].status = 'AUTENTICADO';
    sseEmit(botId, 'status', { botId, status: 'AUTENTICADO' });
  });

  // ── EVENTO: Listo ──────────────────────────────────────────────
  client.on('ready', async () => {
    log(botId, 'SUCCESS', '✅ WhatsApp conectado y listo');
    bots[botId].status = 'CONECTADO';

    const info = client.info;
    const numero = info ? info.wid.user : 'desconocido';
    bots[botId].numero = numero;

    sseEmit(botId, 'ready', { botId, numero, status: 'CONECTADO' });

    // Guardar token de sesión en Apps Script
    await notificarAppsScript(botId, {
      op:      'qr',
      qr:      'CONECTADO',
      numero,
      session: `session_${botId}_${Date.now()}`
    });

    // Cargar configuración actualizada
    await obtenerConfigDesdeSheets(botId);

    log(botId, 'SUCCESS', `Bot listo — número: +${numero}`);
  });

  // ── EVENTO: Desconectado ───────────────────────────────────────
  client.on('disconnected', async (reason) => {
    log(botId, 'WARN', `Desconectado: ${reason}`);
    bots[botId].status = 'DESCONECTADO';
    sseEmit(botId, 'status', { botId, status: 'DESCONECTADO', reason });
  });

  // ── EVENTO: Error de autenticación ────────────────────────────
  client.on('auth_failure', (msg) => {
    log(botId, 'ERROR', `Auth fallida: ${msg}`);
    bots[botId].status = 'AUTH_ERROR';
    sseEmit(botId, 'status', { botId, status: 'AUTH_ERROR', message: msg });
  });

  // ── EVENTO: Mensaje entrante ───────────────────────────────────
  client.on('message', async (msg) => {
    await procesarMensaje(botId, msg);
  });

  // Iniciar cliente
  try {
    await client.initialize();
  } catch (err) {
    log(botId, 'ERROR', `Error al inicializar: ${err.message}`);
    bots[botId].status = 'ERROR';
  }

  return bots[botId];
}

// ─────────────────────────────────────────────────────────────────
//  DESTRUIR UN BOT
// ─────────────────────────────────────────────────────────────────
async function destruirBot(botId) {
  const bot = bots[botId];
  if (!bot) return;
  try {
    await bot.client.destroy();
    log(botId, 'INFO', 'Cliente destruido');
  } catch (_) {}
  delete bots[botId];
}

// ─────────────────────────────────────────────────────────────────
//  PROCESAR MENSAJE ENTRANTE
// ─────────────────────────────────────────────────────────────────
async function procesarMensaje(botId, msg) {
  const bot = bots[botId];
  if (!bot) return;

  const cfg       = bot.config;
  const numero    = msg.from;
  const esGrupo   = msg.from.includes('@g.us');
  const cuerpo    = (msg.body || '').trim();

  // Ignorar mensajes propios
  if (msg.fromMe) return;

  // Filtro de grupos
  if (esGrupo) {
    const modoGrupos = cfg.SYS_RECIBE_GRUPOS || 'NO';
    if (modoGrupos === 'NO') return;
    if (modoGrupos !== 'SI' && modoGrupos !== numero) return;
  }

  // Filtro horario
  if (!dentroDeHorario(cfg)) {
    log(botId, 'INFO', `Mensaje fuera de horario — ignorado (${numero})`);
    return;
  }

  // Rate limit
  if (!checkRateLimit(botId, numero)) {
    log(botId, 'WARN', `Rate limit alcanzado para ${numero}`);
    return;
  }

  // Mensajes seguidos sin respuesta
  const maxSeq = parseInt(cfg.SYS_MAX_MSGS_SEQ) || 3;
  if (!bot.msgCount[numero]) bot.msgCount[numero] = 0;
  bot.msgCount[numero]++;
  if (bot.msgCount[numero] > maxSeq) {
    log(botId, 'WARN', `Demasiados mensajes seguidos de ${numero} — ignorado`);
    return;
  }

  log(botId, 'INFO', `📩 ${numero}: ${cuerpo.substring(0, 60)}`);

  const proveedor = (cfg.IA_PROVEEDOR || 'NORMAL').toUpperCase();

  try {
    if (proveedor === 'NORMAL') {
      await responderConArbol(botId, msg, numero, cuerpo);
    } else {
      await responderConIA(botId, msg, numero, cuerpo, proveedor);
    }
    bot.msgCount[numero] = 0;
  } catch (err) {
    log(botId, 'ERROR', `Error procesando mensaje de ${numero}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────
//  RESPONDER CON ÁRBOL (modo NORMAL)
// ─────────────────────────────────────────────────────────────────
async function responderConArbol(botId, msg, numero, cuerpo) {
  const bot = bots[botId];
  const cfg = bot.config;

  const respuesta = await notificarAppsScript(botId, {
    op:      'find_conversacion',
    numero,
    mensaje: cuerpo,
    token:   bot.token
  });

  if (!respuesta || respuesta.status !== '0') {
    log(botId, 'WARN', `Árbol conversación sin respuesta para ${numero}`);
    return;
  }

  const mensajes = respuesta.mensajes || [];
  await enviarMensajes(botId, msg, numero, mensajes, cfg);
}

// ─────────────────────────────────────────────────────────────────
//  RESPONDER CON IA
// ─────────────────────────────────────────────────────────────────
async function responderConIA(botId, msg, numero, cuerpo, proveedor) {
  const bot  = bots[botId];
  const cfg  = bot.config;
  const t0   = Date.now();

  // Reinicio/cierre de memoria
  const comandos = parsearComandos(cfg.IA_COMANDOS_CHAT || '');
  for (const [accion, keyword] of Object.entries(comandos)) {
    if (cuerpo.toUpperCase() === keyword.toUpperCase()) {
      if (accion.toUpperCase().includes('REINICIO')) {
        delete bot.memory[numero];
        log(botId, 'INFO', `Memoria reiniciada para ${numero}`);
      }
      if (accion.toUpperCase().includes('CIERRE')) {
        delete bot.memory[numero];
      }
    }
  }

  // Construir historial de conversación
  if (!bot.memory[numero]) bot.memory[numero] = [];
  const historial = bot.memory[numero];

  // Historial máximo: últimas 20 interacciones
  if (historial.length > 40) historial.splice(0, historial.length - 40);

  // Construir prompt del sistema con reemplazos
  let promptSistema = cfg.IA_PROMPT_SISTEMA || '';
  promptSistema = promptSistema.replace('@productos@', bot.productos || '');
  promptSistema = promptSistema.replace('@conocimiento@', bot.conocimiento || '');

  let respuestaTexto = '';

  try {
    switch (proveedor) {
      case 'CHATGPT_ASISTENTE':
        respuestaTexto = await iaOpenAIAssistant(cfg, historial, cuerpo, numero);
        break;
      case 'CHATGPTAPI_ASISTENTE':
        respuestaTexto = await iaOpenAIChat(cfg, promptSistema, historial, cuerpo);
        break;
      case 'GEMINI_ASISTENTE':
      case 'GEMINI':
        respuestaTexto = await iaGemini(cfg, promptSistema, historial, cuerpo);
        break;
      case 'CLAUDE_ASISTENTE':
      case 'CLAUDE':
        respuestaTexto = await iaClaude(cfg, promptSistema, historial, cuerpo);
        break;
      case 'DEEPSEEK_ASISTENTE':
      case 'DEEPSEEK':
        respuestaTexto = await iaDeepSeek(cfg, promptSistema, historial, cuerpo);
        break;
      case 'MISTRAL_ASISTENTE':
      case 'MISTRAL':
        respuestaTexto = await iaMistral(cfg, promptSistema, historial, cuerpo);
        break;
      case 'QWEN_ASISTENTE':
      case 'QWEN':
        respuestaTexto = await iaQwen(cfg, promptSistema, historial, cuerpo);
        break;
      default:
        respuestaTexto = 'Proveedor de IA no reconocido: ' + proveedor;
    }
  } catch (err) {
    log(botId, 'ERROR', `Error IA (${proveedor}): ${err.message}`);
    respuestaTexto = 'Disculpa, tuve un problema al procesar tu mensaje. Por favor intenta de nuevo.';
  }

  // Agregar al historial si la memoria está activa
  if (cfg.IA_MEMORIA === 'SI') {
    historial.push({ role: 'user',      content: cuerpo });
    historial.push({ role: 'assistant', content: respuestaTexto });
  }

  // Parsear mensajes (URLs, multimedia embebida)
  const mensajes = parsearRespuestaIA(respuestaTexto);
  await enviarMensajes(botId, msg, numero, mensajes, cfg);

  // Registrar en Apps Script
  const duracion = Date.now() - t0;
  await notificarAppsScript(botId, {
    op:       'saveMessage',
    from:     numero,
    message:  cuerpo,
    response: respuestaTexto,
    engine:   proveedor,
    duration: duracion,
    token:    bot.token
  });

  log(botId, 'SUCCESS', `IA respondió (${proveedor}) en ${duracion}ms a ${numero}`);
}

// ─────────────────────────────────────────────────────────────────
//  PARSEAR RESPUESTA IA → ARRAY DE MENSAJES
// ─────────────────────────────────────────────────────────────────
function parsearRespuestaIA(texto) {
  const mensajes = [];

  // Tags <url>
  const urlTags = (texto + '').match(/<url>.*?<\/url>/g);
  if (urlTags) {
    urlTags.forEach(tag => {
      texto = texto.replace(tag, '');
      mensajes.push({ tipo: 'url', mensaje_salida: tag.replace('<url>', '').replace('</url>', '') });
    });
  }

  // Tags <mapa>
  const mapaTags = (texto + '').match(/<mapa>.*?<\/mapa>/g);
  if (mapaTags) {
    mapaTags.forEach(tag => {
      texto = texto.replace(tag, '');
      mensajes.push({ tipo: 'location', mensaje_salida: tag.replace('<mapa>', '').replace('</mapa>', '') });
    });
  }

  // URLs directas
  const urlsDirectas = (texto + '').match(/https?:\/\/[^\s]+(\.png|\.jpg|\.jpeg|\.pdf|\.mp3|\.ogg)/gi);
  if (urlsDirectas) {
    urlsDirectas.forEach(url => {
      texto = texto.replace(url, '[ver adjunto]');
      mensajes.push({ tipo: 'url', mensaje_salida: url });
    });
  }

  // Limpiar texto final
  const textoLimpio = texto.trim();
  if (textoLimpio) {
    mensajes.unshift({ tipo: 'mensaje', mensaje_salida: textoLimpio });
  }

  return mensajes;
}

// ─────────────────────────────────────────────────────────────────
//  ENVIAR ARRAY DE MENSAJES (con typing + delays)
// ─────────────────────────────────────────────────────────────────
async function enviarMensajes(botId, msg, numero, mensajes, cfg) {
  const bot    = bots[botId];
  const client = bot.client;

  if (!client || bots[botId].status !== 'CONECTADO') {
    log(botId, 'WARN', 'Cliente no conectado — no se pueden enviar mensajes');
    return;
  }

  const delayMin      = parseInt(cfg.SYS_DELAY_MIN) || 2;
  const delayMax      = parseInt(cfg.SYS_DELAY_MAX) || 5;
  const variance      = parseInt(cfg.AB_DELAY_VARIANCE) || 20;
  const typingSim     = cfg.AB_TYPING_SIM !== 'NO';
  const typingSpeed   = parseInt(cfg.AB_TYPING_SPEED) || 180;
  const thinkTime     = parseFloat(cfg.AB_THINK_TIME) || 1.5;
  const pauseMultiple = parseInt(cfg.AB_PAUSE_BETWEEN) || 8;

  // Pausa de "pensamiento"
  if (thinkTime > 0) await sleep(thinkTime * 1000);

  for (let i = 0; i < mensajes.length; i++) {
    const item = mensajes[i];

    // Pausa entre mensajes múltiples
    if (i > 0) await sleep(pauseMultiple * 1000);

    // Delay aleatorio anti-bloqueo
    const delay = randomDelay(delayMin, delayMax, variance);
    await sleep(delay);

    try {
      if (item.tipo === 'mensaje' || item.tipo === undefined) {
        const texto = limpiarTexto(item.mensaje_salida, cfg);
        if (!texto) continue;

        // Simular typing
        if (typingSim) {
          const duracionTyping = Math.min((texto.length / typingSpeed) * 60 * 1000, 8000);
          await client.sendPresenceAvailable();
          const chat = await msg.getChat();
          await chat.sendStateTyping();
          await sleep(duracionTyping);
          await chat.clearState();
        }

        await client.sendMessage(numero, texto);
        log(botId, 'SUCCESS', `✉️  Enviado a ${numero}: ${texto.substring(0, 50)}...`);

      } else if (item.tipo === 'url') {
        const urlMedia = item.mensaje_salida;
        try {
          const media = await MessageMedia.fromUrl(urlMedia, { unsafeMime: true });
          await client.sendMessage(numero, media, { caption: item.nombrearchivo || '' });
          log(botId, 'SUCCESS', `📎 Media enviada a ${numero}: ${urlMedia}`);
        } catch (mediaErr) {
          // Fallback: enviar como texto
          await client.sendMessage(numero, `📎 ${urlMedia}`);
          log(botId, 'WARN', `Media falló, enviado como enlace: ${mediaErr.message}`);
        }

      } else if (item.tipo === 'location') {
        const coords = (item.mensaje_salida || '').split(',');
        if (coords.length >= 2) {
          const lat = parseFloat(coords[0]);
          const lng = parseFloat(coords[1]);
          const desc = coords[2] || 'Ubicación';
          const Location = require('whatsapp-web.js').Location;
          await client.sendMessage(numero, new Location(lat, lng, desc));
          log(botId, 'SUCCESS', `📍 Ubicación enviada a ${numero}`);
        }
      }
    } catch (sendErr) {
      log(botId, 'ERROR', `Error enviando a ${numero}: ${sendErr.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  LIMPIEZA DE TEXTO
// ─────────────────────────────────────────────────────────────────
function limpiarTexto(texto, cfg) {
  if (!texto) return '';
  if (cfg.SYS_ACTIVAR_LIMPIEZA !== 'SI' || !cfg.SYS_PALABRAS_LIMPIAR) return texto;

  const palabras = (cfg.SYS_PALABRAS_LIMPIAR + '').split(':::');
  palabras.forEach(p => {
    if (p) texto = texto.split(p).join('');
  });

  return texto.trim();
}

// ─────────────────────────────────────────────────────────────────
//  PARSEAR COMANDOS  "REINICIO: MENU | CIERRE: ADIOS"
// ─────────────────────────────────────────────────────────────────
function parsearComandos(str) {
  const mapa = {};
  if (!str) return mapa;
  str.split('|').forEach(par => {
    const [accion, keyword] = par.split(':').map(s => s.trim());
    if (accion && keyword) mapa[accion] = keyword;
  });
  return mapa;
}

// ═══════════════════════════════════════════════════════════════════
//  MOTORES DE IA
// ═══════════════════════════════════════════════════════════════════

// ── OpenAI Assistants API ──────────────────────────────────────────
async function iaOpenAIAssistant(cfg, historial, mensaje, threadKey) {
  const apiKey       = cfg.IA_TOKEN_SECRETO;
  const assistantId  = cfg.IA_ASISTENTE_ID;
  if (!apiKey || !assistantId) throw new Error('OpenAI API Key o Assistant ID no configurados');

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
    'OpenAI-Beta':   'assistants=v2'
  };

  // Obtener o crear thread
  if (!global.openaiThreads) global.openaiThreads = {};
  let threadId = global.openaiThreads[threadKey];

  if (!threadId) {
    const threadRes = await axios.post('https://api.openai.com/v1/threads', {}, { headers });
    threadId = threadRes.data.id;
    global.openaiThreads[threadKey] = threadId;
  }

  // Agregar mensaje
  await axios.post(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    role: 'user', content: mensaje
  }, { headers });

  // Crear run
  const runRes = await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    assistant_id: assistantId
  }, { headers });
  let runId = runRes.data.id;

  // Polling (max 60 seg)
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const statusRes = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, { headers });
    const status = statusRes.data.status;
    if (status === 'completed') break;
    if (['failed', 'cancelled', 'expired'].includes(status)) throw new Error(`Run ${status}`);
  }

  // Obtener respuesta
  const msgsRes = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages?limit=1&order=desc`, { headers });
  const msgs    = msgsRes.data.data;
  if (!msgs || !msgs.length) throw new Error('Sin respuesta del asistente');

  return msgs[0].content.map(c => c.text ? c.text.value : '').join('');
}

// ── OpenAI Chat Completion ─────────────────────────────────────────
async function iaOpenAIChat(cfg, promptSistema, historial, mensaje) {
  const apiKey = cfg.IA_TOKEN_SECRETO;
  if (!apiKey) throw new Error('OpenAI API Key no configurada');

  const messages = [
    { role: 'system', content: promptSistema },
    ...historial.slice(-20),
    { role: 'user',   content: mensaje }
  ];

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model:       cfg.IA_MODELO_VERSION || 'gpt-4o',
    messages,
    temperature: parseFloat(cfg.IA_TEMPERATURA) || 0.7,
    max_tokens:  parseInt(cfg.IA_MAX_TOKENS)    || 800
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  });

  return res.data.choices[0].message.content;
}

// ── Google Gemini ──────────────────────────────────────────────────
async function iaGemini(cfg, promptSistema, historial, mensaje) {
  const apiKey = cfg.IA_TOKEN_SECRETO;
  if (!apiKey) throw new Error('Gemini API Key no configurada');

  const modelo  = cfg.IA_MODELO_VERSION || 'gemini-1.5-flash';
  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

  // Construir historial compatible con Gemini
  const contents = historial.slice(-20).map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  contents.push({ role: 'user', parts: [{ text: mensaje }] });

  const res = await axios.post(baseUrl, {
    system_instruction: { parts: [{ text: promptSistema }] },
    contents,
    generationConfig: {
      temperature:     parseFloat(cfg.IA_TEMPERATURA) || 0.7,
      maxOutputTokens: parseInt(cfg.IA_MAX_TOKENS)    || 800
    }
  }, { headers: { 'Content-Type': 'application/json' } });

  const candidates = res.data.candidates;
  if (!candidates || !candidates[0]) throw new Error('Sin candidatos en respuesta Gemini');
  return candidates[0].content.parts.map(p => p.text || '').join('');
}

// ── Anthropic Claude ───────────────────────────────────────────────
async function iaClaude(cfg, promptSistema, historial, mensaje) {
  const apiKey = cfg.IA_TOKEN_SECRETO;
  if (!apiKey) throw new Error('Claude API Key no configurada');

  const messages = [
    ...historial.slice(-20).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: mensaje }
  ];

  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model:      cfg.IA_MODELO_VERSION || 'claude-sonnet-4-5',
    max_tokens: parseInt(cfg.IA_MAX_TOKENS) || 800,
    system:     promptSistema,
    messages
  }, {
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json'
    }
  });

  return res.data.content[0].text;
}

// ── DeepSeek ────────────────────────────────────────────────────────
async function iaDeepSeek(cfg, promptSistema, historial, mensaje) {
  const apiKey = cfg.IA_TOKEN_SECRETO;
  if (!apiKey) throw new Error('DeepSeek API Key no configurada');

  const messages = [
    { role: 'system', content: promptSistema },
    ...historial.slice(-20),
    { role: 'user',   content: mensaje }
  ];

  const res = await axios.post('https://api.deepseek.com/v1/chat/completions', {
    model:       cfg.IA_MODELO_VERSION || 'deepseek-chat',
    messages,
    temperature: parseFloat(cfg.IA_TEMPERATURA) || 0.7,
    max_tokens:  parseInt(cfg.IA_MAX_TOKENS)    || 800
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  });

  return res.data.choices[0].message.content;
}

// ── Mistral ─────────────────────────────────────────────────────────
async function iaMistral(cfg, promptSistema, historial, mensaje) {
  const apiKey = cfg.IA_TOKEN_SECRETO;
  if (!apiKey) throw new Error('Mistral API Key no configurada');

  const messages = [
    { role: 'system', content: promptSistema },
    ...historial.slice(-20),
    { role: 'user',   content: mensaje }
  ];

  const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
    model:       cfg.IA_MODELO_VERSION || 'mistral-large-latest',
    messages,
    temperature: parseFloat(cfg.IA_TEMPERATURA) || 0.7,
    max_tokens:  parseInt(cfg.IA_MAX_TOKENS)    || 800
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  });

  return res.data.choices[0].message.content;
}

// ── Alibaba Qwen ────────────────────────────────────────────────────
async function iaQwen(cfg, promptSistema, historial, mensaje) {
  const apiKey = cfg.IA_TOKEN_SECRETO;
  if (!apiKey) throw new Error('Qwen API Key no configurada');

  const messages = [
    { role: 'system', content: promptSistema },
    ...historial.slice(-20),
    { role: 'user',   content: mensaje }
  ];

  const res = await axios.post('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    model:       cfg.IA_MODELO_VERSION || 'qwen-max',
    messages,
    temperature: parseFloat(cfg.IA_TEMPERATURA) || 0.7,
    max_tokens:  parseInt(cfg.IA_MAX_TOKENS)    || 800
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  });

  return res.data.choices[0].message.content;
}

// ─────────────────────────────────────────────────────────────────
//  CONFIG POR DEFECTO
// ─────────────────────────────────────────────────────────────────
function defaultConfig() {
  return {
    SYS_RECIBE_GRUPOS:      'NO',
    SYS_DELAY_MIN:          '2',
    SYS_DELAY_MAX:          '5',
    SYS_ACTIVAR_LIMPIEZA:   'NO',
    SYS_PALABRAS_LIMPIAR:   '',
    SYS_ACTIVAR_CENSURA:    'NO',
    SYS_HORA_INICIO:        '08:00',
    SYS_HORA_FIN:           '22:00',
    SYS_MAX_MSGS_SEQ:       '3',
    SYS_RATE_LIMIT_HORA:    '15',
    IA_PROVEEDOR:           'NORMAL',
    IA_TEMPERATURA:         '0.7',
    IA_MAX_TOKENS:          '800',
    IA_MEMORIA:             'SI',
    IA_PROMPT_SISTEMA:      'Eres un asistente útil. Responde siempre en español.',
    IA_COMANDOS_CHAT:       'REINICIO: MENU | CIERRE: ADIOS',
    AB_TYPING_SIM:          'SI',
    AB_TYPING_SPEED:        '180',
    AB_THINK_TIME:          '1.5',
    AB_PAUSE_BETWEEN:       '8',
    AB_DELAY_VARIANCE:      '20',
    AB_MSG_VARIATION:       'SI',
    AB_ONLY_REPLY:          'SI',
    AB_HORARIO_ACTIVO:      'SI',
    SISTEMA_CAPTURA_LEADS:  'SI, CAPTURAR'
  };
}

// ═══════════════════════════════════════════════════════════════════
//  RUTAS REST — Panel Frontend
// ═══════════════════════════════════════════════════════════════════

// ── Health check ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const botsSummary = Object.keys(bots).map(id => ({
    id,
    status:     bots[id].status,
    numero:     bots[id].numero     || null,
    webhookUrl: bots[id].webhookUrl || '',
    token:      bots[id].token      || '',
    proveedor:  bots[id].config ? (bots[id].config.IA_PROVEEDOR || 'NORMAL') : 'NORMAL'
  }));
  res.json({
    status:    'OK',
    version:   '3.0',
    bots:      botsSummary,
    timestamp: new Date().toISOString()
  });
});

// ── Iniciar QR de un bot ───────────────────────────────────────────
app.post('/iniciarqr', async (req, res) => {
  const { botId = 'default', app_script, token, sheet_id } = req.body;

  if (!bots[botId]) {
    const webhookUrl = app_script || process.env.DEFAULT_WEBHOOK_URL || '';
    const tokenBot   = token     || process.env.DEFAULT_TOKEN        || '';
    await crearBot(botId, webhookUrl, tokenBot);
  } else {
    // Regenerar QR si ya existe
    const bot = bots[botId];
    if (bot.status === 'CONECTADO') {
      return res.json({ status: '0', message: 'Bot ya conectado', numero: bot.numero });
    }
    if (bot.qrDataUrl) {
      return res.json({ status: '0', message: 'QR disponible', qr: bot.qrCode, qrDataUrl: bot.qrDataUrl, qrUrl: `${PUBLIC_URL}/qr/${botId}` });
    }
  }

  res.json({ status: '0', message: 'Bot iniciando — escanea el QR en: ' + `${PUBLIC_URL}/qr/${botId}`, qrUrl: `${PUBLIC_URL}/qr/${botId}` });
});

// ── SSE: stream de QR en tiempo real ──────────────────────────────
app.get('/qr/:botId/stream', (req, res) => {
  const { botId } = req.params;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  if (!bots[botId]) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Bot no encontrado' })}\n\n`);
    return res.end();
  }

  bots[botId].sseClients.push(res);

  // Enviar estado actual inmediatamente
  const bot = bots[botId];
  if (bot.qrDataUrl) {
    res.write(`event: qr\ndata: ${JSON.stringify({ botId, qrDataUrl: bot.qrDataUrl, qrUrl: `${PUBLIC_URL}/qr/${botId}` })}\n\n`);
  }
  res.write(`event: status\ndata: ${JSON.stringify({ botId, status: bot.status })}\n\n`);

  // Heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch (_) {}
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (bots[botId]) {
      bots[botId].sseClients = bots[botId].sseClients.filter(c => c !== res);
    }
  });
});

// ── Página QR (HTML visual) ────────────────────────────────────────
app.get('/qr/:botId', (req, res) => {
  const { botId } = req.params;
  const bot = bots[botId];
  const status    = bot ? bot.status : 'NO_EXISTE';
  const qrDataUrl = bot ? (bot.qrDataUrl || '') : '';
  const numero    = bot ? (bot.numero || '') : '';

  const statusColor = {
    CONECTADO:      '#25D366',
    QR_PENDIENTE:   '#F59E0B',
    INICIANDO:      '#3B82F6',
    DESCONECTADO:   '#EF4444',
    AUTH_ERROR:     '#EF4444',
    ERROR:          '#EF4444',
    NO_EXISTE:      '#6B7280'
  }[status] || '#6B7280';

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR — ${botId} · WA Bot Manager</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0a0a0a;--card:#141414;--border:rgba(255,255,255,.08);--accent:#25D366;--text:#e0ede5;--muted:#888}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:32px;width:100%;max-width:420px;text-align:center}
  .logo{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:24px}
  .logo-icon{width:44px;height:44px;background:rgba(37,211,102,.15);border:1px solid rgba(37,211,102,.3);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px}
  .logo-text{font-size:16px;font-weight:700;color:#c8f0d4}
  .bot-id{font-size:11px;font-family:monospace;color:var(--muted);margin-bottom:20px;padding:4px 12px;background:rgba(255,255,255,.04);border-radius:20px;display:inline-block}
  .status-pill{font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;letter-spacing:.06em;text-transform:uppercase;display:inline-flex;align-items:center;gap:6px;margin-bottom:20px;background:rgba(37,211,102,.1);color:${statusColor};border:1px solid ${statusColor}33}
  .dot{width:7px;height:7px;border-radius:50%;background:${statusColor};animation:pulse 1.5s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(1.2)}}
  .qr-box{background:white;padding:16px;border-radius:14px;display:inline-block;margin:16px 0;box-shadow:0 4px 20px rgba(0,0,0,.4)}
  .qr-box img{display:block;width:260px;height:260px}
  .instructions{font-size:12px;color:var(--muted);line-height:1.7;margin-top:16px}
  .instructions strong{color:#c8f0d4}
  .btn{display:inline-flex;align-items:center;gap:8px;background:rgba(37,211,102,.1);border:1px solid rgba(37,211,102,.25);color:var(--accent);font-size:12px;font-weight:600;padding:10px 20px;border-radius:10px;cursor:pointer;text-decoration:none;margin-top:16px;transition:.15s}
  .btn:hover{background:rgba(37,211,102,.18)}
  .connected-box{background:rgba(37,211,102,.08);border:1px solid rgba(37,211,102,.25);border-radius:12px;padding:24px;text-align:center}
  .connected-icon{font-size:48px;margin-bottom:12px}
  .connected-num{font-size:18px;font-weight:700;color:#25D366;font-family:monospace;margin-top:8px}
  .footer{font-size:11px;color:var(--muted);font-family:monospace}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">📱</div>
    <div class="logo-text">WA Bot Manager PRO</div>
  </div>
  <div class="bot-id">${botId}</div><br>
  <div class="status-pill"><span class="dot"></span><span id="statusText">${status}</span></div>

  <div id="qr-section">
    ${status === 'CONECTADO' ? `
    <div class="connected-box">
      <div class="connected-icon">✅</div>
      <div style="color:#c8f0d4;font-weight:600">Bot conectado</div>
      <div class="connected-num">+${numero}</div>
    </div>` : qrDataUrl ? `
    <div class="qr-box">
      <img id="qrImg" src="${qrDataUrl}" alt="QR WhatsApp">
    </div>
    <div class="instructions">
      <strong>Cómo conectar:</strong><br>
      1. Abre WhatsApp en tu teléfono<br>
      2. Ve a <strong>Dispositivos vinculados</strong><br>
      3. Toca <strong>Vincular un dispositivo</strong><br>
      4. Escanea este código QR
    </div>` : `
    <div style="padding:40px 0;color:var(--muted)">
      <div style="font-size:32px;margin-bottom:12px">⏳</div>
      <div>Generando QR...</div>
    </div>`}
  </div>

  <a class="btn" href="/qr/${botId}/png" target="_blank">⬇️ Descargar QR PNG</a>
  <a class="btn" href="/health" target="_blank">📊 Estado del servidor</a>
</div>

<div class="footer">WA Bot Manager PRO v3.0 · ${new Date().toLocaleString('es-PE')}</div>

<script>
const botId = '${botId}';
const evtSrc = new EventSource('/qr/' + botId + '/stream');

evtSrc.addEventListener('qr', e => {
  const d = JSON.parse(e.data);
  const sec = document.getElementById('qr-section');
  sec.innerHTML = '<div class="qr-box"><img id="qrImg" src="' + d.qrDataUrl + '" alt="QR"></div>' +
    '<div class="instructions"><strong>Cómo conectar:</strong><br>1. Abre WhatsApp<br>2. Dispositivos vinculados<br>3. Vincular un dispositivo<br>4. Escanea este QR</div>';
  document.getElementById('statusText').textContent = 'QR DISPONIBLE';
});

evtSrc.addEventListener('ready', e => {
  const d = JSON.parse(e.data);
  document.getElementById('statusText').textContent = 'CONECTADO';
  document.getElementById('qr-section').innerHTML =
    '<div class="connected-box"><div class="connected-icon">✅</div>' +
    '<div style="color:#c8f0d4;font-weight:600">Conectado correctamente</div>' +
    '<div class="connected-num">+' + d.numero + '</div></div>';
  evtSrc.close();
});

evtSrc.addEventListener('status', e => {
  const d = JSON.parse(e.data);
  document.getElementById('statusText').textContent = d.status;
});
</script>
</body>
</html>`);
});

// ── QR como imagen PNG ─────────────────────────────────────────────
app.get('/qr/:botId/png', async (req, res) => {
  const { botId } = req.params;
  const bot = bots[botId];

  if (!bot || !bot.qrCode) {
    return res.status(404).json({ error: 'QR no disponible para este bot' });
  }

  try {
    const buffer = await qrcode.toBuffer(bot.qrCode, { width: 400, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="qr_${botId}.png"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Estado de un bot ───────────────────────────────────────────────
app.get('/status/:botId', (req, res) => {
  const { botId } = req.params;
  const bot = bots[botId];
  if (!bot) return res.json({ status: '0', botStatus: 'NO_EXISTE', connected: false });

  res.json({
    status:       '0',
    botId,
    botStatus:    bot.status,
    connected:    bot.status === 'CONECTADO',
    numero:       bot.numero || null,
    proveedor:    bot.config.IA_PROVEEDOR || 'NORMAL',
    qrUrl:        `${PUBLIC_URL}/qr/${botId}`,
    qrPngUrl:     `${PUBLIC_URL}/qr/${botId}/png`,
    streamUrl:    `${PUBLIC_URL}/qr/${botId}/stream`,
    timestamp:    new Date().toISOString()
  });
});

// ── Validar número WA ──────────────────────────────────────────────
app.post('/validate', async (req, res) => {
  const { botId = 'default', token } = req.body;
  const bot = bots[botId];

  if (!bot || bot.status !== 'CONECTADO') {
    return res.json({ status: '-1', message: 'Bot no conectado' });
  }

  // Validar config cargada
  await obtenerConfigDesdeSheets(botId);
  res.json({
    status:    '0',
    message:   'Configuración válida',
    botId,
    numero:    bot.numero,
    proveedor: bot.config.IA_PROVEEDOR,
    modelo:    bot.config.IA_MODELO_VERSION,
    timestamp: new Date().toISOString()
  });
});

// ── Limpiar memoria IA ─────────────────────────────────────────────
app.post('/clear-memory', (req, res) => {
  const { botId = 'default' } = req.body;
  const bot = bots[botId];
  if (!bot) return res.json({ status: '-1', message: 'Bot no encontrado' });

  bot.memory    = {};
  bot.msgCount  = {};
  bot.rateLimit = {};
  log(botId, 'INFO', 'Memoria y contadores limpiados');
  res.json({ status: '0', message: 'Memoria limpiada' });
});

// ── Obtener grupos ─────────────────────────────────────────────────
app.post('/get-groups', async (req, res) => {
  const { botId = 'default' } = req.body;
  const bot = bots[botId];
  if (!bot || bot.status !== 'CONECTADO') {
    return res.json({ status: '-1', message: 'Bot no conectado' });
  }

  try {
    const chats  = await bot.client.getChats();
    const grupos = chats
      .filter(c => c.isGroup)
      .map(c => ({ id_grupo: c.id._serialized, nombre_grupo: c.name }));

    // Guardar en Sheets
    await notificarAppsScript(botId, {
      op: 'grupos', mensajes: grupos, token: bot.token
    });

    res.json({ status: '0', message: `${grupos.length} grupos encontrados`, grupos });
  } catch (err) {
    res.json({ status: '-1', message: err.message });
  }
});

// ── Obtener contactos ──────────────────────────────────────────────
app.post('/get-contacts', async (req, res) => {
  const { botId = 'default' } = req.body;
  const bot = bots[botId];
  if (!bot || bot.status !== 'CONECTADO') {
    return res.json({ status: '-1', message: 'Bot no conectado' });
  }

  try {
    const contacts   = await bot.client.getContacts();
    const contactos  = contacts
      .filter(c => c.isMyContact && !c.isGroup && c.id.server === 'c.us')
      .map(c => ({ id_contacto: c.id._serialized, nombre_contacto: c.name || c.pushname || c.id.user }));

    await notificarAppsScript(botId, {
      op: 'contactos', mensajes: contactos, token: bot.token
    });

    res.json({ status: '0', message: `${contactos.length} contactos`, contactos });
  } catch (err) {
    res.json({ status: '-1', message: err.message });
  }
});

// ── Regenerar QR ──────────────────────────────────────────────────
app.post('/generate-qr', async (req, res) => {
  const { botId = 'default', token, app_script } = req.body;

  if (bots[botId]) await destruirBot(botId);

  const webhookUrl = app_script || process.env.DEFAULT_WEBHOOK_URL || '';
  const tok        = token      || process.env.DEFAULT_TOKEN        || '';
  await crearBot(botId, webhookUrl, tok);

  res.json({
    status:  '0',
    message: 'Bot reiniciado — QR en proceso',
    qrUrl:   `${PUBLIC_URL}/qr/${botId}`,
    stream:  `${PUBLIC_URL}/qr/${botId}/stream`
  });
});

// ── Probar alerta ──────────────────────────────────────────────────
app.post('/test-alert', async (req, res) => {
  const { botId = 'default' } = req.body;
  const bot = bots[botId];
  if (!bot || bot.status !== 'CONECTADO') {
    return res.json({ status: '-1', message: 'Bot no conectado' });
  }

  try {
    const cfg     = bot.config;
    const numAdmin = cfg.SYS_NUMERO_NOTIF_WA || '';
    const msgAdmin = cfg.SYS_MSG_NOTIF_WA || 'Test de alerta desde WA Bot Manager PRO';

    if (!numAdmin) return res.json({ status: '-1', message: 'SYS_NUMERO_NOTIF_WA no configurado' });

    await bot.client.sendMessage(`${numAdmin}@c.us`, `🔔 ${msgAdmin} (${new Date().toLocaleString('es-PE')})`);
    res.json({ status: '0', message: 'Alerta enviada a ' + numAdmin });
  } catch (err) {
    res.json({ status: '-1', message: err.message });
  }
});

// ── Enviar mensaje manual (desde Apps Script / panel) ─────────────
app.post('/enviar-mensaje', async (req, res) => {
  const body   = req.body;
  const botId  = body.botId || 'default';
  const bot    = bots[botId];

  if (!bot) return res.json({ status: '-1', message: 'Bot no encontrado' });
  if (bot.status !== 'CONECTADO') return res.json({ status: '-1', message: 'Bot no conectado' });

  const op       = body.op || '';
  const mensajes = body.mensajes || [];
  const listener = body.listener;

  // Op: registermessage (masivo)
  if (op === 'registermessage') {

    // Actualizar modelo/proveedor si viene en el body
    if (body.tipobot) {
      bot.config.IA_PROVEEDOR = body.tipobot;
      log(botId, 'INFO', `Proveedor IA cambiado a: ${body.tipobot}`);
    }

    // Sincronizar memoria si viene conversacion_bot con 'datos' o 'memoria'
    if (body.conversacion_bot) {
      const tipo = body.conversacion_bot[0]?.inicio || '';
      if (tipo === 'datos' || tipo === 'memoria') {
        await obtenerConfigDesdeSheets(botId);
      }
    }

    // Validar números
    if (body.validar_numero && body.validar_numero.length > 0) {
      const resultados = await Promise.all(
        body.validar_numero.map(async v => {
          try {
            const num    = `${v.numero}@c.us`;
            const existe = await bot.client.isRegisteredUser(num);
            return { posicion: v.posicion, estado: existe ? 'Tiene WhatsApp' : 'Sin WhatsApp' };
          } catch (_) {
            return { posicion: v.posicion, estado: 'Número inválido' };
          }
        })
      );
      if (listener) {
        await notificarAppsScript(botId, { op: 'save_validanumero', validar_numero: resultados, token: bot.token });
      }
      return res.json({ status: '0', message: 'Validación completada', validar_numero: resultados });
    }

    // Obtener grupos
    if (body.grupos && body.grupos.length > 0) {
      const chats  = await bot.client.getChats();
      const grupos = chats.filter(c => c.isGroup).map(c => ({
        id_grupo: c.id._serialized, nombre_grupo: c.name
      }));
      if (listener) {
        await notificarAppsScript(botId, { op: 'grupos', mensajes: grupos, token: bot.token });
      }
      return res.json({ status: '0', grupos });
    }

    // Obtener contactos
    if (body.contactos && body.contactos.length > 0) {
      const contacts  = await bot.client.getContacts();
      const contactos = contacts
        .filter(c => c.isMyContact && !c.isGroup && c.id.server === 'c.us')
        .map(c => ({ id_contacto: c.id._serialized, nombre_contacto: c.name || c.pushname || '' }));
      if (listener) {
        await notificarAppsScript(botId, { op: 'contactos', mensajes: contactos, token: bot.token });
      }
      return res.json({ status: '0', contactos });
    }

    // Envíos masivos (mensajemanual / programados)
    if (mensajes.length > 0) {
      const resultados = [];
      for (const item of mensajes) {
        const numero = `${item.numero}@c.us`;
        const delay  = item.intervalo_mensaje ? parseInt(item.intervalo_mensaje) * 1000 : randomDelay(2, 5);
        await sleep(delay);
        try {
          if (item.mensaje) {
            await bot.client.sendMessage(numero, item.mensaje);
            resultados.push({ posicion: item.posicion, estado: 'Enviado' });
          }
          if (item.url) {
            const media = await MessageMedia.fromUrl(item.url, { unsafeMime: true });
            await bot.client.sendMessage(numero, media);
            resultados.push({ posicion: item.posicion, estado: 'Enviado' });
          }
        } catch (sendErr) {
          resultados.push({ posicion: item.posicion, estado: 'Error: ' + sendErr.message });
        }
      }

      if (listener && resultados.length > 0) {
        const cbOp = body.config?.operacion === 'resultadoprogramar' ? 'resultadoprogramar' : 'resultado';
        await notificarAppsScript(botId, { op: cbOp, mensajes: resultados, token: bot.token });
      }

      return res.json({ status: '0', message: `${resultados.length} mensajes procesados`, mensajes: resultados });
    }

    return res.json({ status: '0', message: 'Sin mensajes que procesar' });
  }

  res.json({ status: '-1', message: 'Operación no reconocida: ' + op });
});

// ═══════════════════════════════════════════════════════════════════
//  PÁGINA DE ESTADO GENERAL (/)
// ═══════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>


    
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WA Bot Manager PRO — Panel de Conexión</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
/* ═══════ TOKENS ═══════ */
:root {
  --bg:     #080d0a;
  --bg1:    #0c1410;
  --bg2:    #111a14;
  --bg3:    #172019;
  --bg4:    #1d2a1f;
  --line:   rgba(37,211,102,.10);
  --line2:  rgba(37,211,102,.20);
  --green:  #25D366;
  --green2: #1aab52;
  --green3: #0d7a35;
  --glow:   rgba(37,211,102,.15);
  --text:   #c8e8ce;
  --muted:  #5a7860;
  --muted2: #8aab8e;
  --mono:   'Space Mono', monospace;
  --sans:   'Syne', sans-serif;
  --red:    #ff4d4d;
  --amber:  #ffb347;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  min-height: 100vh;
  overflow-x: hidden;
}

/* ── GRID DE FONDO ── */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(rgba(37,211,102,.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(37,211,102,.03) 1px, transparent 1px);
  background-size: 40px 40px;
  pointer-events: none;
  z-index: 0;
}

/* ── HEADER ── */
header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(8,13,10,.92);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
  padding: 0 32px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo-mark {
  width: 36px;
  height: 36px;
  background: var(--glow);
  border: 1px solid var(--line2);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  position: relative;
}

.logo-mark::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(37,211,102,.3), transparent);
  pointer-events: none;
}

.logo-text {
  font-family: var(--sans);
  font-weight: 800;
  font-size: 15px;
  color: #e8f5ea;
  letter-spacing: -.3px;
}

.logo-ver {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--muted);
  letter-spacing: .08em;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
  animation: pulse-ring 2s ease-in-out infinite;
}

@keyframes pulse-ring {
  0%, 100% { box-shadow: 0 0 4px var(--green); }
  50% { box-shadow: 0 0 14px var(--green), 0 0 24px rgba(37,211,102,.3); }
}

.server-status {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted2);
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ── LAYOUT PRINCIPAL ── */
.wrap {
  position: relative;
  z-index: 1;
  max-width: 1200px;
  margin: 0 auto;
  padding: 36px 32px 60px;
}

/* ── SECCIÓN TÍTULO ── */
.hero {
  margin-bottom: 40px;
}

.hero-label {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--green);
  letter-spacing: .15em;
  text-transform: uppercase;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.hero-label::before {
  content: '';
  display: inline-block;
  width: 24px;
  height: 1px;
  background: var(--green);
}

.hero h1 {
  font-size: 32px;
  font-weight: 800;
  color: #e8f5ea;
  letter-spacing: -.5px;
  line-height: 1.1;
  margin-bottom: 6px;
}

.hero-sub {
  font-size: 13px;
  color: var(--muted2);
  font-weight: 400;
}

/* ── STATS BAR ── */
.stats-bar {
  display: flex;
  gap: 2px;
  margin-bottom: 36px;
}

.stat {
  background: var(--bg2);
  border: 1px solid var(--line);
  padding: 12px 20px;
  flex: 1;
  position: relative;
  overflow: hidden;
}

.stat:first-child { border-radius: 10px 0 0 10px; }
.stat:last-child  { border-radius: 0 10px 10px 0; }

.stat::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--green), transparent);
  opacity: 0;
  transition: opacity .3s;
}

.stat:hover::before { opacity: 1; }

.stat-val {
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 700;
  color: var(--green);
  line-height: 1;
  margin-bottom: 4px;
}

.stat-lbl {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .08em;
}

/* ── FORMULARIO NUEVO BOT ── */
.add-bot-section {
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 24px;
  margin-bottom: 36px;
  position: relative;
  overflow: hidden;
}

.add-bot-section::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent 10%, var(--green) 50%, transparent 90%);
}

.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.section-icon {
  width: 30px;
  height: 30px;
  background: var(--glow);
  border: 1px solid var(--line2);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}

.section-title {
  font-size: 13px;
  font-weight: 700;
  color: #c8e8ce;
  letter-spacing: -.2px;
}

.section-sub {
  font-size: 11px;
  color: var(--muted2);
  margin-top: 1px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr auto;
  gap: 10px;
  align-items: end;
}

.field label {
  display: block;
  font-family: var(--mono);
  font-size: 9px;
  color: var(--muted);
  letter-spacing: .1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.field input {
  width: 100%;
  background: var(--bg3);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 12px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}

.field input:focus {
  border-color: var(--green2);
  box-shadow: 0 0 0 3px rgba(37,211,102,.08);
}

.field input::placeholder { color: var(--muted); }

.btn-create {
  background: var(--green);
  color: #051a0a;
  border: none;
  border-radius: 8px;
  padding: 10px 20px;
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all .15s;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 7px;
  letter-spacing: -.2px;
}

.btn-create:hover {
  background: #2ae875;
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(37,211,102,.3);
}

.btn-create:active { transform: translateY(0); }

.btn-create:disabled {
  opacity: .5;
  cursor: not-allowed;
  transform: none;
}

/* ── GRID DE TARJETAS ── */
.bots-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.bots-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted2);
  text-transform: uppercase;
  letter-spacing: .1em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.bots-count {
  background: var(--glow);
  border: 1px solid var(--line2);
  border-radius: 20px;
  padding: 2px 8px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--green);
}

.btn-refresh {
  background: none;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 6px 12px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted2);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all .15s;
}

.btn-refresh:hover {
  border-color: var(--line2);
  color: var(--text);
}

.bots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

/* ── TARJETA DE BOT ── */
.bot-card {
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: 16px;
  overflow: hidden;
  transition: border-color .2s, transform .2s;
  position: relative;
}

.bot-card:hover {
  border-color: var(--line2);
  transform: translateY(-2px);
}

.bot-card.status-connected {
  border-color: rgba(37,211,102,.25);
}

.bot-card.status-connected::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--green), transparent);
}

.bot-card.status-qr {
  border-color: rgba(255,179,71,.2);
}

.bot-card.status-error {
  border-color: rgba(255,77,77,.2);
}

/* ── HEADER DE TARJETA ── */
.card-head {
  padding: 16px 18px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
}

.card-id-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-avatar {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--glow);
  border: 1px solid var(--line2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 14px;
  color: var(--green);
  flex-shrink: 0;
  font-family: var(--sans);
}

.card-bot-id {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  color: #ddf0e0;
  letter-spacing: -.3px;
}

.card-webhook {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

/* ── PILL DE STATUS ── */
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 20px;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
  flex-shrink: 0;
}

.pill-connected {
  background: rgba(37,211,102,.1);
  color: var(--green);
  border: 1px solid rgba(37,211,102,.25);
}

.pill-qr {
  background: rgba(255,179,71,.08);
  color: var(--amber);
  border: 1px solid rgba(255,179,71,.2);
}

.pill-starting {
  background: rgba(96,165,250,.08);
  color: #93c5fd;
  border: 1px solid rgba(96,165,250,.18);
}

.pill-disconnected, .pill-error {
  background: rgba(255,77,77,.08);
  color: var(--red);
  border: 1px solid rgba(255,77,77,.2);
}

.pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.pill-connected .pill-dot {
  animation: pulse-ring 1.5s ease-in-out infinite;
  box-shadow: 0 0 4px currentColor;
}

/* ── CUERPO DE TARJETA ── */
.card-body {
  padding: 18px;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

/* ── ZONA QR ── */
.qr-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.qr-frame {
  background: white;
  padding: 10px;
  border-radius: 10px;
  box-shadow: 0 4px 24px rgba(0,0,0,.5);
  position: relative;
  display: inline-block;
}

.qr-frame img {
  display: block;
  width: 180px;
  height: 180px;
}

.qr-instruction {
  font-size: 11px;
  color: var(--muted2);
  text-align: center;
  line-height: 1.6;
}

.qr-instruction strong { color: #c8e8ce; }

/* ── ZONA CONECTADO ── */
.connected-zone {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.connected-check {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(37,211,102,.1);
  border: 2px solid rgba(37,211,102,.3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
}

.connected-number {
  font-family: var(--mono);
  font-size: 18px;
  font-weight: 700;
  color: var(--green);
  letter-spacing: .5px;
}

.connected-label {
  font-size: 11px;
  color: var(--muted2);
}

/* ── ZONA CARGANDO ── */
.loading-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 2px solid var(--line);
  border-top-color: var(--green);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.loading-text {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.6;
}

.loading-steps {
  font-size: 10px;
  color: var(--muted);
  font-family: var(--mono);
}

/* ── ZONA DESCONECTADO ── */
.disconnected-zone {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.disc-icon {
  font-size: 36px;
  opacity: .5;
}

.disc-text {
  font-size: 12px;
  color: var(--muted2);
  line-height: 1.5;
}

/* ── FOOTER DE TARJETA ── */
.card-foot {
  padding: 12px 18px;
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--bg1);
}

.card-meta {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--muted);
  line-height: 1.6;
}

.card-meta span {
  display: block;
}

.card-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.btn-action {
  background: var(--bg3);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 6px 10px;
  font-family: var(--mono);
  font-size: 9px;
  color: var(--muted2);
  cursor: pointer;
  transition: all .15s;
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.btn-action:hover {
  background: var(--bg4);
  border-color: var(--line2);
  color: var(--text);
}

.btn-action.btn-regen:hover {
  color: var(--amber);
  border-color: rgba(255,179,71,.3);
}

.btn-action.btn-del:hover {
  color: var(--red);
  border-color: rgba(255,77,77,.3);
}

.btn-action.btn-reconnect {
  color: var(--green);
  border-color: rgba(37,211,102,.25);
}

.btn-action.btn-reconnect:hover {
  background: rgba(37,211,102,.08);
}

/* ── ESTADO VACÍO ── */
.empty-state {
  grid-column: 1 / -1;
  text-align: center;
  padding: 60px 20px;
  background: var(--bg2);
  border: 1px dashed var(--line2);
  border-radius: 16px;
}

.empty-icon {
  font-size: 40px;
  margin-bottom: 12px;
  opacity: .3;
}

.empty-text {
  font-size: 13px;
  color: var(--muted2);
  margin-bottom: 4px;
}

.empty-sub {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}

/* ── TOAST ── */
#toast-wrap {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  background: var(--bg3);
  border: 1px solid var(--line2);
  color: var(--text);
  font-size: 12px;
  padding: 10px 16px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,.6);
  animation: toast-in .2s ease;
  max-width: 320px;
}

.toast.err { border-color: rgba(255,77,77,.3); color: #ffaaaa; }
.toast.warn { border-color: rgba(255,179,71,.3); color: #ffd080; }

@keyframes toast-in {
  from { opacity:0; transform: translateY(8px); }
  to   { opacity:1; transform: translateY(0); }
}

/* ── RESPONSIVE ── */
@media (max-width: 700px) {
  .wrap { padding: 20px 16px 40px; }
  .form-grid { grid-template-columns: 1fr; }
  header { padding: 0 16px; }
  .stats-bar { flex-wrap: wrap; }
  .stat { border-radius: 8px !important; }
  .hero h1 { font-size: 24px; }
}
</style>
</head>
<body>

<div id="toast-wrap"></div>

<!-- HEADER -->
<header>
  <div class="logo">
    <div class="logo-mark">📱</div>
    <div>
      <div class="logo-text">WA Bot Manager PRO</div>
      <div class="logo-ver">PANEL DE CONEXIÓN · v3.0</div>
    </div>
  </div>
  <div class="header-right">
    <div class="server-status">
      <div class="pulse-dot"></div>
      <span id="server-url-label">localhost</span>
    </div>
  </div>
</header>

<!-- MAIN -->
<div class="wrap">

  <!-- HERO -->
  <div class="hero">
    <div class="hero-label">Panel Central</div>
    <h1>Gestión de Bots WhatsApp</h1>
    <p class="hero-sub">Crea bots, escanea los QR y conecta cada número. Una tarjeta por bot, en tiempo real.</p>
  </div>

  <!-- STATS -->
  <div class="stats-bar">
    <div class="stat">
      <div class="stat-val" id="stat-total">0</div>
      <div class="stat-lbl">Bots totales</div>
    </div>
    <div class="stat">
      <div class="stat-val" id="stat-connected">0</div>
      <div class="stat-lbl">Conectados</div>
    </div>
    <div class="stat">
      <div class="stat-val" id="stat-qr">0</div>
      <div class="stat-lbl">Esperando QR</div>
    </div>
    <div class="stat">
      <div class="stat-val" id="stat-offline">0</div>
      <div class="stat-lbl">Desconectados</div>
    </div>
  </div>

  <!-- CREAR BOT -->
  <div class="add-bot-section">
    <div class="section-header">
      <div class="section-icon">➕</div>
      <div>
        <div class="section-title">Crear nuevo bot</div>
        <div class="section-sub">Cada bot tiene su propio número de WhatsApp y configuración independiente</div>
      </div>
    </div>
    <div class="form-grid">
      <div class="field">
        <label>ID del Bot</label>
        <input type="text" id="f-botid" placeholder="ej: ventas_empresa" oninput="this.value=this.value.replace(/[^a-z0-9_]/gi,'_').toLowerCase()">
      </div>
      <div class="field">
        <label>URL Apps Script (webhook)</label>
        <input type="text" id="f-webhook" placeholder="https://script.google.com/macros/s/.../exec">
      </div>
      <div class="field">
        <label>Token de seguridad</label>
        <input type="text" id="f-token" placeholder="ej: 16092000">
      </div>
      <div class="field">
        <button class="btn-create" id="btn-crear" onclick="crearBot()">
          <span>＋</span> Crear Bot
        </button>
      </div>
    </div>
  </div>

  <!-- BOTS -->
  <div class="bots-header">
    <div class="bots-title">
      Bots activos
      <span class="bots-count" id="bots-count-badge">0</span>
    </div>
    <button class="btn-refresh" onclick="recargarBots()">
      <span id="refresh-icon">⟳</span> Actualizar
    </button>
  </div>

  <div class="bots-grid" id="bots-grid">
    <div class="empty-state">
      <div class="empty-icon">🤖</div>
      <div class="empty-text">Sin bots activos</div>
      <div class="empty-sub">Crea tu primer bot usando el formulario de arriba</div>
    </div>
  </div>

</div>

<script>
'use strict';

// ─── ESTADO GLOBAL ────────────────────────────────────────────────
const sseConexiones = {};  // botId → EventSource
const estadoBots    = {};  // botId → { status, numero, webhookUrl, token }

// ─── HELPERS ──────────────────────────────────────────────────────
function toast(msg, tipo = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (tipo === 'err' ? ' err' : tipo === 'warn' ? ' warn' : '');
  el.innerHTML = (tipo === 'err' ? '✗ ' : tipo === 'warn' ? '⚠ ' : '✓ ') + esc(msg);
  document.getElementById('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function truncar(url, max = 36) {
  if (!url || url.length <= max) return url || '—';
  return url.slice(0, max) + '…';
}

// ─── ACTUALIZAR STATS ─────────────────────────────────────────────
function actualizarStats() {
  const todos  = Object.values(estadoBots);
  const total  = todos.length;
  const conn   = todos.filter(b => b.status === 'CONECTADO').length;
  const qr     = todos.filter(b => b.status === 'QR_PENDIENTE').length;
  const off    = todos.filter(b => ['DESCONECTADO','ERROR','AUTH_ERROR'].includes(b.status)).length;

  document.getElementById('stat-total').textContent     = total;
  document.getElementById('stat-connected').textContent = conn;
  document.getElementById('stat-qr').textContent        = qr;
  document.getElementById('stat-offline').textContent   = off;
  document.getElementById('bots-count-badge').textContent = total;
}

// ─── OBTENER CLASE DE STATUS ──────────────────────────────────────
function claseStatus(status) {
  if (status === 'CONECTADO')   return 'status-connected';
  if (status === 'QR_PENDIENTE') return 'status-qr';
  if (['DESCONECTADO','ERROR','AUTH_ERROR'].includes(status)) return 'status-error';
  return 'status-starting';
}

function pillClass(status) {
  if (status === 'CONECTADO')    return 'pill-connected';
  if (status === 'QR_PENDIENTE') return 'pill-qr';
  if (status === 'INICIANDO' || status === 'AUTENTICADO') return 'pill-starting';
  return 'pill-disconnected';
}

function pillLabel(status) {
  const map = {
    CONECTADO: '● Conectado',
    QR_PENDIENTE: '◌ QR Listo',
    INICIANDO: '◌ Iniciando',
    AUTENTICADO: '◌ Autenticando',
    DESCONECTADO: '✕ Desconectado',
    ERROR: '✕ Error',
    AUTH_ERROR: '✕ Auth Error'
  };
  return map[status] || status;
}

// ─── RENDERIZAR CUERPO DE TARJETA ─────────────────────────────────
function renderCuerpo(bot) {
  const { status, numero, qrDataUrl } = bot;

  if (status === 'CONECTADO') {
    return \`
      <div class="connected-zone">
        <div class="connected-check">✅</div>
        <div class="connected-number">+\${esc(numero || '—')}</div>
        <div class="connected-label">WhatsApp vinculado correctamente</div>
      </div>\`;
  }

  if (status === 'QR_PENDIENTE' && qrDataUrl) {
    return \`
      <div class="qr-zone">
        <div class="qr-frame">
          <img src="\${esc(qrDataUrl)}" alt="QR \${esc(bot.id)}" width="180" height="180">
        </div>
        <div class="qr-instruction">
          <strong>Cómo conectar:</strong><br>
          Abre WhatsApp → Dispositivos vinculados<br>
          → Vincular dispositivo → Escanea
        </div>
      </div>\`;
  }

  if (status === 'DESCONECTADO' || status === 'ERROR' || status === 'AUTH_ERROR') {
    return \`
      <div class="disconnected-zone">
        <div class="disc-icon">⚠️</div>
        <div class="disc-text">Bot desconectado<br><span style="font-family:var(--mono);font-size:9px;color:var(--muted)">\${esc(status)}</span></div>
      </div>\`;
  }

  // INICIANDO / AUTENTICADO / QR_PENDIENTE sin imagen aún
  const paso = status === 'AUTENTICADO'
    ? 'Autenticado — cargando configuración...'
    : 'Chromium iniciando — aguarda el QR...';

  return \`
    <div class="loading-zone">
      <div class="spinner"></div>
      <div class="loading-text">\${esc(paso)}</div>
      <div class="loading-steps">El QR llegará automáticamente vía SSE</div>
    </div>\`;
}

// ─── RENDERIZAR ACCIONES DE TARJETA ──────────────────────────────
function renderAcciones(bot) {
  const { status, id } = bot;

  if (status === 'CONECTADO') {
    return \`
      <button class="btn-action btn-regen" onclick="regenerarQR('\${esc(id)}')">⟳ Regenerar</button>
      <button class="btn-action btn-del"   onclick="confirmarEliminar('\${esc(id)}')">✕ Borrar</button>\`;
  }

  if (status === 'DESCONECTADO' || status === 'ERROR' || status === 'AUTH_ERROR') {
    return \`
      <button class="btn-action btn-reconnect" onclick="reconectar('\${esc(id)}')">↺ Reconectar</button>
      <button class="btn-action btn-del"       onclick="confirmarEliminar('\${esc(id)}')">✕ Borrar</button>\`;
  }

  if (status === 'QR_PENDIENTE') {
    return \`
      <button class="btn-action btn-regen" onclick="regenerarQR('\${esc(id)}')">⟳ Nuevo QR</button>
      <button class="btn-action btn-del"   onclick="confirmarEliminar('\${esc(id)}')">✕ Borrar</button>\`;
  }

  return \`<button class="btn-action btn-del" onclick="confirmarEliminar('\${esc(id)}')">✕ Borrar</button>\`;
}

// ─── CREAR / ACTUALIZAR TARJETA EN EL DOM ────────────────────────
function upsertTarjeta(bot) {
  const grid    = document.getElementById('bots-grid');
  const cardId  = 'card-' + bot.id;
  let   card    = document.getElementById(cardId);

  // Quitar empty state si es la primera tarjeta
  const empty = grid.querySelector('.empty-state');
  if (empty) empty.remove();

  const avatarLetra = bot.id.charAt(0).toUpperCase();
  const statusClass = claseStatus(bot.status);
  const pClass      = pillClass(bot.status);
  const pLabel      = pillLabel(bot.status);
  const cuerpo      = renderCuerpo(bot);
  const acciones    = renderAcciones(bot);

  const html = \`
    <div class="card-head">
      <div class="card-id-wrap">
        <div class="card-avatar">\${avatarLetra}</div>
        <div>
          <div class="card-bot-id">\${esc(bot.id)}</div>
          <div class="card-webhook">\${truncar(bot.webhookUrl)}</div>
        </div>
      </div>
      <span class="status-pill \${pClass}">
        <span class="pill-dot"></span>\${pLabel}
      </span>
    </div>
    <div class="card-body" id="body-\${esc(bot.id)}">\${cuerpo}</div>
    <div class="card-foot">
      <div class="card-meta">
        <span>ID: <strong style="color:var(--text);font-family:var(--mono)">\${esc(bot.id)}</strong></span>
        <span>Token: <strong style="color:var(--text);font-family:var(--mono)">\${bot.token ? '••••••' : '—'}</strong></span>
        \${bot.numero ? \`<span>Número: <strong style="color:var(--green);font-family:var(--mono)">+\${esc(bot.numero)}</strong></span>\` : ''}
      </div>
      <div class="card-actions">\${acciones}</div>
    </div>\`;

  if (card) {
    card.className = \`bot-card \${statusClass}\`;
    card.innerHTML = html;
  } else {
    card = document.createElement('div');
    card.id = cardId;
    card.className = \`bot-card \${statusClass}\`;
    card.innerHTML = html;
    grid.appendChild(card);
  }

  actualizarStats();
}

// ─── ACTUALIZAR SOLO EL BODY DE UNA TARJETA ──────────────────────
function actualizarCuerpoTarjeta(botId) {
  const bot  = estadoBots[botId];
  if (!bot) return;

  const body = document.getElementById('body-' + botId);
  if (body) body.innerHTML = renderCuerpo(bot);

  // Actualizar pill y clases
  const card = document.getElementById('card-' + botId);
  if (card) {
    card.className = \`bot-card \${claseStatus(bot.status)}\`;
    const pill = card.querySelector('.status-pill');
    if (pill) {
      pill.className = \`status-pill \${pillClass(bot.status)}\`;
      pill.innerHTML = \`<span class="pill-dot"></span>\${pillLabel(bot.status)}\`;
    }
    const foot = card.querySelector('.card-actions');
    if (foot) foot.innerHTML = renderAcciones(bot);

    // Actualizar número en meta si ya conectó
    if (bot.numero) {
      const meta = card.querySelector('.card-meta');
      if (meta && !meta.innerHTML.includes('Número:')) {
        meta.innerHTML += \`<span>Número: <strong style="color:var(--green);font-family:var(--mono)">+\${esc(bot.numero)}</strong></span>\`;
      }
    }
  }

  actualizarStats();
}

// ─── ABRIR SSE PARA UN BOT ────────────────────────────────────────
function abrirSSE(botId) {
  // Cerrar anterior si existe
  if (sseConexiones[botId]) {
    sseConexiones[botId].close();
    delete sseConexiones[botId];
  }

  const sse = new EventSource(\`/qr/\${encodeURIComponent(botId)}/stream\`);
  sseConexiones[botId] = sse;

  sse.addEventListener('qr', e => {
    const d = JSON.parse(e.data);
    if (estadoBots[botId]) {
      estadoBots[botId].qrDataUrl = d.qrDataUrl;
      estadoBots[botId].status    = 'QR_PENDIENTE';
    }
    actualizarCuerpoTarjeta(botId);
  });

  sse.addEventListener('ready', e => {
    const d = JSON.parse(e.data);
    if (estadoBots[botId]) {
      estadoBots[botId].status = 'CONECTADO';
      estadoBots[botId].numero = d.numero;
      estadoBots[botId].qrDataUrl = null;
    }
    actualizarCuerpoTarjeta(botId);
    toast(\`✅ Bot "\${botId}" conectado — +\${d.numero}\`);
    // Cerrar SSE, ya no hace falta
    sse.close();
    delete sseConexiones[botId];
  });

  sse.addEventListener('status', e => {
    const d = JSON.parse(e.data);
    if (estadoBots[botId]) {
      estadoBots[botId].status = d.status;
      if (d.status === 'DESCONECTADO' || d.status === 'AUTH_ERROR') {
        estadoBots[botId].qrDataUrl = null;
      }
    }
    actualizarCuerpoTarjeta(botId);
    if (d.status === 'DESCONECTADO') {
      toast(\`Bot "\${botId}" se desconectó\`, 'warn');
    }
  });

  sse.addEventListener('error', e => {
    // EventSource reconecta automáticamente — solo logueamos
    console.warn('[SSE] Reconectando para', botId, e);
  });
}

// ─── CARGAR BOTS DESDE /health ────────────────────────────────────
async function recargarBots() {
  const icon = document.getElementById('refresh-icon');
  icon.style.animation = 'spin 1s linear infinite';
  icon.style.display   = 'inline-block';

  try {
    const res  = await fetch('/health');
    const data = await res.json();

    // Cerrar SSE de bots que ya no existen
    const idsActuales = new Set((data.bots || []).map(b => b.id));
    Object.keys(sseConexiones).forEach(id => {
      if (!idsActuales.has(id)) {
        sseConexiones[id].close();
        delete sseConexiones[id];
        delete estadoBots[id];
        const card = document.getElementById('card-' + id);
        if (card) card.remove();
      }
    });

    // Agregar o actualizar bots
    (data.bots || []).forEach(b => {
      if (!estadoBots[b.id]) {
        estadoBots[b.id] = {
          id:         b.id,
          status:     b.status,
          numero:     b.numero || null,
          webhookUrl: b.webhookUrl || '',
          token:      b.token     || '',
          qrDataUrl:  null
        };
        upsertTarjeta(estadoBots[b.id]);
        // Abrir SSE si no está conectado todavía
        if (b.status !== 'CONECTADO') {
          abrirSSE(b.id);
        }
      } else {
        estadoBots[b.id].status = b.status;
        if (b.numero) estadoBots[b.id].numero = b.numero;
        actualizarCuerpoTarjeta(b.id);
      }
    });

    // Si no hay bots, mostrar empty state
    if ((data.bots || []).length === 0) {
      const grid = document.getElementById('bots-grid');
      grid.innerHTML = \`
        <div class="empty-state">
          <div class="empty-icon">🤖</div>
          <div class="empty-text">Sin bots activos</div>
          <div class="empty-sub">Crea tu primer bot usando el formulario de arriba</div>
        </div>\`;
      actualizarStats();
    }

  } catch (err) {
    toast('Error al cargar bots: ' + err.message, 'err');
  } finally {
    setTimeout(() => {
      icon.style.animation = '';
    }, 400);
  }
}

// ─── CREAR BOT ────────────────────────────────────────────────────
async function crearBot() {
  const botId   = document.getElementById('f-botid').value.trim();
  const webhook = document.getElementById('f-webhook').value.trim();
  const token   = document.getElementById('f-token').value.trim();

  if (!botId) { toast('El ID del bot es obligatorio', 'warn'); return; }

  const btn = document.getElementById('btn-crear');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:1.5px;display:inline-block"></span> Creando...';

  // Registrar en estado local
  estadoBots[botId] = {
    id:         botId,
    status:     'INICIANDO',
    numero:     null,
    webhookUrl: webhook,
    token:      token,
    qrDataUrl:  null
  };

  upsertTarjeta(estadoBots[botId]);

  // CRÍTICO: abrir SSE ANTES de llamar a /iniciarqr
  // para no perderse el evento 'qr' cuando llegue
  abrirSSE(botId);

  try {
    const res = await fetch('/iniciarqr', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId, app_script: webhook, token })
    });
    const data = await res.json();

    if (data.status === '0') {
      // Si ya estaba conectado
      if (data.numero) {
        estadoBots[botId].status = 'CONECTADO';
        estadoBots[botId].numero = data.numero;
        actualizarCuerpoTarjeta(botId);
        toast(\`Bot "\${botId}" ya estaba conectado (+\${data.numero})\`);
      } else {
        toast(\`Bot "\${botId}" iniciado — esperando QR...\`);
      }
    } else {
      toast('Error al iniciar bot: ' + (data.message || '?'), 'err');
    }
  } catch (err) {
    toast('Error de conexión: ' + err.message, 'err');
    estadoBots[botId].status = 'ERROR';
    actualizarCuerpoTarjeta(botId);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>＋</span> Crear Bot';
    document.getElementById('f-botid').value   = '';
    document.getElementById('f-webhook').value = '';
    document.getElementById('f-token').value   = '';
  }
}

// ─── REGENERAR QR ─────────────────────────────────────────────────
async function regenerarQR(botId) {
  const bot = estadoBots[botId];
  if (!bot) return;

  bot.status    = 'INICIANDO';
  bot.qrDataUrl = null;
  actualizarCuerpoTarjeta(botId);

  // Reabrir SSE
  abrirSSE(botId);

  try {
    await fetch('/generate-qr', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botId,
        token:      bot.token,
        app_script: bot.webhookUrl
      })
    });
    toast(\`Regenerando QR para "\${botId}"...\`);
  } catch (err) {
    toast('Error: ' + err.message, 'err');
  }
}

// ─── RECONECTAR BOT ───────────────────────────────────────────────
async function reconectar(botId) {
  const bot = estadoBots[botId];
  if (!bot) return;

  bot.status    = 'INICIANDO';
  bot.qrDataUrl = null;
  actualizarCuerpoTarjeta(botId);

  abrirSSE(botId);

  try {
    const res  = await fetch('/iniciarqr', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botId,
        app_script: bot.webhookUrl,
        token:      bot.token
      })
    });
    const data = await res.json();
    toast(data.message || \`Reconectando "\${botId}"...\`);
  } catch (err) {
    toast('Error: ' + err.message, 'err');
  }
}

// ─── CONFIRMAR ELIMINAR ───────────────────────────────────────────
function confirmarEliminar(botId) {
  if (!confirm(\`¿Eliminar el bot "\${botId}" del panel?\n\nEsto NO destruye la sesión de WhatsApp.\`)) return;

  // Cerrar SSE
  if (sseConexiones[botId]) {
    sseConexiones[botId].close();
    delete sseConexiones[botId];
  }
  delete estadoBots[botId];

  const card = document.getElementById('card-' + botId);
  if (card) card.remove();

  const grid = document.getElementById('bots-grid');
  if (grid.children.length === 0) {
    grid.innerHTML = \`
      <div class="empty-state">
        <div class="empty-icon">🤖</div>
        <div class="empty-text">Sin bots activos</div>
        <div class="empty-sub">Crea tu primer bot usando el formulario de arriba</div>
      </div>\`;
  }

  actualizarStats();
  toast(\`Bot "\${botId}" eliminado del panel\`);
}

// ─── INIT ─────────────────────────────────────────────────────────
(async function init() {
  // Mostrar la URL del servidor en el header
  document.getElementById('server-url-label').textContent =
    window.location.host || 'localhost';

  // Cargar bots existentes al arrancar
  await recargarBots();
})();
</script>
</body>
</html>`);
});



async function sincronizarBotsDesdeSheets() {
  const webhookUrl = process.env.DEFAULT_WEBHOOK_URL;
  const token = process.env.DEFAULT_TOKEN;
  
  console.log('🔍 Iniciando sincronización...');
  console.log('📡 Webhook:', webhookUrl);
  
  if (!webhookUrl) {
    console.log('❌ No hay DEFAULT_WEBHOOK_URL configurado');
    return;
  }
  
  try {
    const url = `${webhookUrl}?action=listarBots&token=${encodeURIComponent(token || '')}`;
    console.log('🌐 Consultando:', url);
    
    const res = await axios.get(url, { timeout: 15000 });
    console.log('📦 Respuesta completa:', JSON.stringify(res.data, null, 2));
    
    const botsFromSheets = res.data.bots || [];
    console.log(`📋 Bots encontrados en Sheets:`, botsFromSheets);
    
    for (const nombreOriginal of botsFromSheets) {
      console.log(`\n🔄 Procesando: "${nombreOriginal}"`);
      
      // Limpiar el nombre
      let limpio = String(nombreOriginal)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      
      if (!limpio) limpio = 'bot_' + Date.now();
      
      console.log(`   → ID generado: "${limpio}"`);
      
      if (!bots[limpio]) {
        console.log(`   ✨ Creando bot nuevo...`);
        await crearBot(limpio, webhookUrl, token || '');
        console.log(`   ✅ Creado: ${limpio}`);
      } else {
        console.log(`   ⏭️ Ya existe: ${limpio}`);
      }
    }
    
    console.log('✅ Sincronización completada');
    
  } catch(err) {
    console.log('❌ ERROR en sincronización:');
    console.log('   Mensaje:', err.message);
    if (err.response) {
      console.log('   Status:', err.response.status);
      console.log('   Data:', err.response.data);
    }
  }
}




// ─────────────────────────────────────────────────────────────────
//  INICIAR SERVIDOR
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {


  console.log('\x1b[32m');
  console.log('═══════════════════════════════════════════════════');
  console.log('  WA Bot Manager PRO — Node.js Server v3.0');
  console.log(`  Puerto   : ${PORT}`);
  console.log(`  URL      : ${PUBLIC_URL}`);
  console.log(`  Panel QR : ${PUBLIC_URL}/qr/<botId>`);
  console.log(`  Estado   : ${PUBLIC_URL}/health`);
  console.log('═══════════════════════════════════════════════════');
  console.log('\x1b[0m');

  await sincronizarBotsDesdeSheets();
  // ← Cierre del app.listen
  // Auto-cargar bots desde variables de entorno
  // Formato: BOT_1=botId|webhookUrl|token
  let i = 1;
  while (process.env[`BOT_${i}`]) {
    const parts   = process.env[`BOT_${i}`].split('|');
    const botId   = parts[0];
    const webhook = parts[1] || process.env.DEFAULT_WEBHOOK_URL || '';
    const token   = parts[2] || process.env.DEFAULT_TOKEN       || '';
    if (botId) {
      log(botId, 'INFO', `Auto-cargando bot desde env BOT_${i}`);
      crearBot(botId, webhook, token);
    }
    i++;
  }

  // Si no hay bots en env, lanzar uno de ejemplo
  if (i === 1 && process.env.DEFAULT_WEBHOOK_URL) {
    const defaultBotId = 'default';
    log(defaultBotId, 'INFO', 'Iniciando bot por defecto');
    crearBot(defaultBotId, process.env.DEFAULT_WEBHOOK_URL, process.env.DEFAULT_TOKEN || '');
  }
});

module.exports = { app, crearBot, destruirBot, bots };
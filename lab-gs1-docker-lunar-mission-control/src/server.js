const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
require('dotenv').config();

const app = express();

const config = {
  port: Number(process.env.APP_PORT || 3000),
  missionName: process.env.MISSION_NAME || 'Artemis FIAP Lunar Base',
  environment: process.env.NODE_ENV || process.env.APP_ENV || 'development',
  db: {
    host: process.env.DB_HOST || 'mysql',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'lunar_user',
    password: process.env.DB_PASSWORD || 'lunarpass',
    database: process.env.DB_NAME || process.env.MYSQL_DATABASE || 'lunar_mission'
  },
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT || 6379)
  }
};

let pool;
let redisClient;

app.use(express.json());
app.use('/static', express.static(path.join(__dirname, '..', 'public')));
app.use('/media', express.static(path.join(__dirname, '..', 'public', 'media')));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMetricStatus(metricKey, value) {
  const numeric = Number(value);
  if (metricKey === 'temperature') {
    if (numeric <= -95 || numeric >= 35) return 'critical';
    if (numeric <= -75 || numeric >= 25) return 'warning';
    return 'ok';
  }

  if (['energy', 'oxygen', 'communication', 'water', 'robotics'].includes(metricKey)) {
    if (numeric < 45) return 'critical';
    if (numeric < 70) return 'warning';
    return 'ok';
  }

  return 'ok';
}

async function connectMysqlWithRetry(maxAttempts = 40) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      pool = mysql.createPool({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true
      });
      await pool.query('SELECT 1');
      console.log(`[database] conectado em ${config.db.host}:${config.db.port}/${config.db.database}`);
      return;
    } catch (error) {
      console.log(`[database] aguardando MySQL... tentativa ${attempt}/${maxAttempts} - ${error.message}`);
      if (pool) {
        try { await pool.end(); } catch (_) {}
      }
      await sleep(3000);
    }
  }
  throw new Error('Não foi possível conectar ao MySQL dentro do tempo esperado.');
}

async function connectRedisWithRetry(maxAttempts = 40) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = createClient({
      url: `redis://${config.redis.host}:${config.redis.port}`
    });

    client.on('error', (error) => {
      console.log(`[redis] ${error.message}`);
    });

    try {
      await client.connect();
      await client.ping();
      redisClient = client;
      console.log(`[redis] conectado em ${config.redis.host}:${config.redis.port}`);
      return;
    } catch (error) {
      console.log(`[redis] aguardando Redis... tentativa ${attempt}/${maxAttempts} - ${error.message}`);
      try { await client.disconnect(); } catch (_) {}
      await sleep(2000);
    }
  }
  throw new Error('Não foi possível conectar ao Redis dentro do tempo esperado.');
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mission_metrics (
      metric_key VARCHAR(50) PRIMARY KEY,
      metric_label VARCHAR(100) NOT NULL,
      metric_value DECIMAL(10,2) NOT NULL,
      metric_unit VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS robots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(30) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      task VARCHAR(160) NOT NULL,
      battery DECIMAL(10,2) NOT NULL,
      status VARCHAR(30) NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mission_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      event_type VARCHAR(60) NOT NULL,
      message VARCHAR(255) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const metrics = [
    ['energy', 'Energia disponível', 78, '%'],
    ['oxygen', 'Oxigênio', 91, '%'],
    ['temperature', 'Temperatura externa', -42, '°C'],
    ['communication', 'Comunicação com a Terra', 97, '%'],
    ['water', 'Estoque de água', 64, '%'],
    ['robotics', 'Status dos robôs', 86, '%']
  ];

  for (const [key, label, value, unit] of metrics) {
    await pool.query(
      `INSERT INTO mission_metrics (metric_key, metric_label, metric_value, metric_unit, status)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE metric_label = VALUES(metric_label), metric_unit = VALUES(metric_unit);`,
      [key, label, value, unit, getMetricStatus(key, value)]
    );
  }

  const robots = [
    ['LNR-01', 'Helios Rover', 'Inspeção dos painéis solares no setor Shackleton', 84, 'operacional'],
    ['LNR-02', 'Gaia Loader', 'Transporte de suprimentos entre módulos pressurizados', 73, 'operacional'],
    ['LNR-03', 'Orion Scout', 'Mapeamento de crateras e análise de terreno', 51, 'manutenção preventiva']
  ];

  for (const robot of robots) {
    await pool.query(
      `INSERT INTO robots (code, name, task, battery, status)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE task = VALUES(task), battery = VALUES(battery), status = VALUES(status);`,
      robot
    );
  }

  const [events] = await pool.query('SELECT COUNT(*) AS total FROM mission_events;');
  if (events[0].total === 0) {
    await pool.query(
      `INSERT INTO mission_events (event_type, message, severity) VALUES
       ('BOOT', 'Mission Control inicializado com telemetria da base lunar.', 'info'),
       ('COMMS', 'Link Terra-Lua operando com baixa latência simulada.', 'success'),
       ('POWER', 'Baterias principais sincronizadas com o setor de energia.', 'info');`
    );
  }

  console.log('[database] schema e dados iniciais prontos');
}

async function clearStatusCache() {
  if (!redisClient || !redisClient.isOpen) return;
  try {
    await redisClient.del('mission:status');
  } catch (error) {
    console.log(`[redis] falha ao limpar cache: ${error.message}`);
  }
}

async function getMissionStatus() {
  if (redisClient && redisClient.isOpen) {
    try {
      const cached = await redisClient.get('mission:status');
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.cache = 'HIT';
        return parsed;
      }
    } catch (error) {
      console.log(`[redis] cache ignorado: ${error.message}`);
    }
  }

  const [metrics] = await pool.query(
    `SELECT metric_key, metric_label, metric_value, metric_unit, status, updated_at
     FROM mission_metrics
     ORDER BY FIELD(metric_key, 'energy', 'oxygen', 'temperature', 'communication', 'water', 'robotics');`
  );

  const [robots] = await pool.query(
    `SELECT code, name, task, battery, status, updated_at
     FROM robots
     ORDER BY code;`
  );

  const [events] = await pool.query(
    `SELECT event_type, message, severity, created_at
     FROM mission_events
     ORDER BY id DESC
     LIMIT 5;`
  );

  const payload = {
    mission: config.missionName,
    environment: config.environment,
    generatedAt: new Date().toISOString(),
    cache: 'MISS',
    metrics: metrics.map((item) => ({
      key: item.metric_key,
      label: item.metric_label,
      value: Number(item.metric_value),
      unit: item.metric_unit,
      status: item.status,
      updatedAt: item.updated_at
    })),
    robots: robots.map((robot) => ({
      code: robot.code,
      name: robot.name,
      task: robot.task,
      battery: Number(robot.battery),
      status: robot.status,
      updatedAt: robot.updated_at
    })),
    events
  };

  if (redisClient && redisClient.isOpen) {
    try {
      await redisClient.setEx('mission:status', 15, JSON.stringify(payload));
    } catch (error) {
      console.log(`[redis] falha ao gravar cache: ${error.message}`);
    }
  }

  return payload;
}

function renderHome() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${config.missionName} | Lunar Mission Control</title>
  <link rel="stylesheet" href="/static/css/style.css" />
</head>
<body>
  <div class="starfield"></div>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark">LM</span>
      <div>
        <strong>Lunar Mission Control</strong>
        <small>Global Solution • Docker Lab</small>
      </div>
    </div>
    <nav>
      <a href="/health" target="_blank">Healthcheck</a>
      <a href="/api/status" target="_blank">API</a>
    </nav>
  </header>

  <main>
    <section class="hero">
      <div class="hero-content">
        <p class="eyebrow">A próxima corrida tecnológica já começou</p>
        <h1>${config.missionName}</h1>
        <p class="lead">Painel de telemetria para monitorar energia, oxigênio, temperatura, comunicação, água e robôs de uma base lunar simulada.</p>
        <div class="hero-actions">
          <button id="simulateBtn" type="button">Simular nova telemetria</button>
          <span id="cacheStatus" class="pill">Aguardando dados...</span>
        </div>
      </div>
      <div class="hero-card">
        <img src="/media/lunar-base.svg" alt="Base lunar futurista" />
        <div class="signal-card">
          <span class="pulse"></span>
          <div>
            <strong>Terra ↔ Lua</strong>
            <small>Link operacional</small>
          </div>
        </div>
      </div>
    </section>

    <section class="section-title">
      <div>
        <p class="eyebrow">Telemetria crítica</p>
        <h2>Status da Base Lunar</h2>
      </div>
      <span id="lastUpdate">Sincronizando...</span>
    </section>

    <section id="metricsGrid" class="metrics-grid"></section>

    <section class="content-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Automação e robótica</p>
            <h2>Robôs operacionais</h2>
          </div>
        </div>
        <div id="robotsList" class="robots-list"></div>
      </div>

      <div class="panel events-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Comunicação e dados</p>
            <h2>Eventos da missão</h2>
          </div>
        </div>
        <div id="eventsList" class="events-list"></div>
      </div>
    </section>
  </main>

  <footer>
    <span>FIAP • Global Solution • Space Connect</span>
    <span>Ambiente: ${config.environment}</span>
  </footer>

  <script src="/static/js/app.js"></script>
</body>
</html>`;
}

app.get('/', (_req, res) => {
  res.type('html').send(renderHome());
});

app.get('/api/status', async (_req, res) => {
  try {
    const status = await getMissionStatus();
    res.json(status);
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: 'Falha ao consultar telemetria', error: error.message });
  }
});

app.post('/api/simulate', async (_req, res) => {
  try {
    const [metrics] = await pool.query('SELECT metric_key, metric_value FROM mission_metrics;');

    for (const metric of metrics) {
      let nextValue = Number(metric.metric_value);
      const variation = Math.floor(Math.random() * 11) - 5;

      if (metric.metric_key === 'temperature') {
        nextValue = Math.max(-110, Math.min(40, nextValue + variation));
      } else {
        nextValue = Math.max(25, Math.min(100, nextValue + variation));
      }

      await pool.query(
        'UPDATE mission_metrics SET metric_value = ?, status = ? WHERE metric_key = ?;',
        [nextValue, getMetricStatus(metric.metric_key, nextValue), metric.metric_key]
      );
    }

    await pool.query(
      'INSERT INTO mission_events (event_type, message, severity) VALUES (?, ?, ?);',
      ['TELEMETRY', 'Nova leitura de telemetria recebida dos módulos lunares.', 'info']
    );

    await clearStatusCache();
    const status = await getMissionStatus();
    res.json(status);
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: 'Falha ao simular telemetria', error: error.message });
  }
});

app.get('/health', async (_req, res) => {
  const checks = {
    app: 'ok',
    mysql: 'unknown',
    redis: 'unknown'
  };

  try {
    await pool.query('SELECT 1');
    checks.mysql = 'ok';
  } catch (error) {
    checks.mysql = `error: ${error.message}`;
  }

  try {
    if (!redisClient || !redisClient.isOpen) throw new Error('Redis não conectado');
    await redisClient.ping();
    checks.redis = 'ok';
  } catch (error) {
    checks.redis = `error: ${error.message}`;
  }

  const healthy = checks.mysql === 'ok' && checks.redis === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    mission: config.missionName,
    environment: config.environment,
    checks,
    timestamp: new Date().toISOString()
  });
});

app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    if (!redisClient || !redisClient.isOpen) throw new Error('Redis não conectado');
    await redisClient.ping();
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not-ready', error: error.message });
  }
});

async function bootstrap() {
  await connectMysqlWithRetry();
  await connectRedisWithRetry();
  await initDatabase();

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[app] ${config.missionName} disponível na porta ${config.port}`);
  });
}

process.on('SIGTERM', async () => {
  console.log('[app] encerrando processo com segurança...');
  try { if (redisClient && redisClient.isOpen) await redisClient.quit(); } catch (_) {}
  try { if (pool) await pool.end(); } catch (_) {}
  process.exit(0);
});

bootstrap().catch((error) => {
  console.error('[app] falha ao iniciar aplicação:', error);
  process.exit(1);
});

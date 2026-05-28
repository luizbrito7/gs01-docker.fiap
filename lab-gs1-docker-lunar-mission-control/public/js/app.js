const metricIcons = {
  energy: '⚡',
  oxygen: 'O₂',
  temperature: '☾',
  communication: '↔',
  water: 'H₂O',
  robotics: '🤖'
};

const statusLabels = {
  ok: 'OK',
  warning: 'Atenção',
  critical: 'Crítico'
};

function formatDate(value) {
  if (!value) return 'sem data';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date(value));
}

function renderMetrics(metrics) {
  const grid = document.getElementById('metricsGrid');
  grid.innerHTML = metrics.map((metric) => `
    <article class="metric-card">
      <div class="metric-top">
        <div>
          <div class="metric-label">${metric.label}</div>
          <small>${formatDate(metric.updatedAt)}</small>
        </div>
        <div class="metric-icon">${metricIcons[metric.key] || '•'}</div>
      </div>
      <div class="metric-value">${Number(metric.value).toLocaleString('pt-BR')}<span>${metric.unit}</span></div>
      <span class="status status-${metric.status}">${statusLabels[metric.status] || metric.status}</span>
    </article>
  `).join('');
}

function renderRobots(robots) {
  const list = document.getElementById('robotsList');
  list.innerHTML = robots.map((robot) => `
    <article class="robot-item">
      <div class="robot-title">
        <strong>${robot.code} • ${robot.name}</strong>
        <span class="pill">${robot.battery}%</span>
      </div>
      <p>${robot.task}</p>
      <div class="battery-bar"><span style="width:${robot.battery}%"></span></div>
      <small>Status: ${robot.status}</small>
    </article>
  `).join('');
}

function renderEvents(events) {
  const list = document.getElementById('eventsList');
  list.innerHTML = events.map((event) => `
    <article class="event-item">
      <div class="event-title">
        <strong>${event.event_type}</strong>
        <span class="status status-${event.severity === 'success' ? 'ok' : 'warning'}">${event.severity}</span>
      </div>
      <p>${event.message}</p>
      <small>${formatDate(event.created_at)}</small>
    </article>
  `).join('');
}

async function loadStatus() {
  const cache = document.getElementById('cacheStatus');
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderMetrics(data.metrics);
    renderRobots(data.robots);
    renderEvents(data.events);
    document.getElementById('lastUpdate').textContent = `Última sincronização: ${formatDate(data.generatedAt)}`;
    cache.textContent = `Cache Redis: ${data.cache}`;
  } catch (error) {
    document.getElementById('metricsGrid').innerHTML = `<div class="error">Falha ao carregar dados: ${error.message}</div>`;
    cache.textContent = 'Falha na comunicação';
  }
}

async function simulateTelemetry() {
  const button = document.getElementById('simulateBtn');
  button.disabled = true;
  button.textContent = 'Simulando...';
  try {
    const response = await fetch('/api/simulate', { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await loadStatus();
  } catch (error) {
    alert(`Erro ao simular telemetria: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Simular nova telemetria';
  }
}

document.getElementById('simulateBtn').addEventListener('click', simulateTelemetry);
loadStatus();
setInterval(loadStatus, 15000);

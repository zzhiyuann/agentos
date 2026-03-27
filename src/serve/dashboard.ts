/** Inline HTML dashboard served at /dashboard */

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentOS &mdash; Company Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .header { padding: 1.5rem 2rem; border-bottom: 1px solid #21262d; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 1.4rem; color: #58a6ff; font-weight: 600; }
  .header .meta { font-size: 0.85rem; color: #484f58; }
  .content { max-width: 1200px; margin: 0 auto; padding: 1.5rem 2rem; }
  .section-title { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #484f58; margin-bottom: 0.75rem; font-weight: 600; }
  .agent-grid { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 2rem; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 1.25rem; min-width: 220px; flex: 1; }
  .card.active { border-color: #238636; }
  .card.idle { border-color: #21262d; }
  .card .role { font-weight: 600; font-size: 1rem; margin-bottom: 0.25rem; color: #e6edf3; }
  .card .model { font-size: 0.8rem; color: #484f58; margin-bottom: 0.5rem; }
  .card .status-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 500; }
  .card .status-badge.active { background: rgba(35, 134, 54, 0.2); color: #3fb950; }
  .card .status-badge.idle { background: rgba(110, 118, 129, 0.15); color: #6e7681; }
  .card .task { font-size: 0.85rem; color: #8b949e; margin-top: 0.5rem; }
  .swarm-section { margin-bottom: 2rem; }
  .swarm-card { background: #161b22; border: 1px solid #da3633; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
  .swarm-card .swarm-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .swarm-card .swarm-name { font-weight: 600; font-size: 1rem; color: #f0883e; }
  .swarm-card .swarm-metric { font-size: 0.85rem; color: #8b949e; }
  .swarm-card .swarm-stats { display: flex; gap: 1.5rem; margin-bottom: 0.75rem; font-size: 0.85rem; }
  .swarm-card .swarm-stats .stat { display: flex; flex-direction: column; }
  .swarm-card .swarm-stats .stat-label { color: #484f58; font-size: 0.75rem; text-transform: uppercase; }
  .swarm-card .swarm-stats .stat-value { color: #e6edf3; font-weight: 600; }
  .swarm-card .swarm-agents { margin-top: 0.5rem; }
  .swarm-card .swarm-agent { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; padding: 0.25rem 0; }
  .swarm-card .swarm-agent .dot { width: 6px; height: 6px; }
  .swarm-card .swarm-exps { margin-top: 0.5rem; font-size: 0.8rem; color: #8b949e; border-top: 1px solid #21262d; padding-top: 0.5rem; }
  .swarm-card .swarm-exp { padding: 0.15rem 0; }
  .swarm-card .swarm-exp .improvement { color: #3fb950; }
  .swarm-card .swarm-exp .regression { color: #f85149; }
  .swarm-card .swarm-exp .error { color: #f85149; }
  .swarm-card .swarm-exp .neutral { color: #484f58; }
  .progress-bar { background: #21262d; border-radius: 4px; height: 6px; overflow: hidden; flex: 1; }
  .progress-bar .fill { background: #f0883e; height: 100%; border-radius: 4px; transition: width 0.3s; }
  .activity { background: #161b22; border: 1px solid #21262d; border-radius: 8px; margin-bottom: 2rem; overflow: hidden; }
  .activity-row { padding: 0.65rem 1rem; border-bottom: 1px solid #21262d; font-size: 0.85rem; display: flex; gap: 0.75rem; align-items: baseline; }
  .activity-row:last-child { border-bottom: none; }
  .activity-row .time { color: #484f58; font-size: 0.8rem; min-width: 140px; }
  .activity-row .agent { color: #58a6ff; font-weight: 500; min-width: 120px; }
  .activity-row .event-type { color: #d2a8ff; min-width: 90px; }
  .activity-row .issue { color: #8b949e; }
  .footer { display: flex; gap: 2rem; padding: 1rem 0; color: #484f58; font-size: 0.85rem; border-top: 1px solid #21262d; margin-top: 1rem; }
  .footer span { display: flex; align-items: center; gap: 0.3rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.green { background: #3fb950; }
  .empty { text-align: center; padding: 2rem; color: #484f58; }
  @media (max-width: 600px) {
    .agent-grid { flex-direction: column; }
    .card { min-width: unset; }
    .content { padding: 1rem; }
    .activity-row { flex-wrap: wrap; }
  }
</style>
</head>
<body>
<div class="header">
  <h1>AgentOS &mdash; Company Dashboard</h1>
  <div class="meta">Auto-refresh: 10s &middot; <span id="last-update"></span></div>
</div>
<div class="content">
  <div class="section-title">Agents</div>
  <div class="agent-grid" id="agents">
    <div class="empty">Loading...</div>
  </div>
  <div id="swarm-section" class="swarm-section" style="display:none;">
    <div class="section-title">Research Swarms</div>
    <div id="swarms"></div>
  </div>
  <div class="section-title">Recent Activity</div>
  <div class="activity" id="activity">
    <div class="empty">Loading...</div>
  </div>
  <div class="footer">
    <span><span class="dot green"></span> Queue: <strong id="queue">-</strong></span>
    <span>Uptime: <strong id="uptime">-</strong></span>
  </div>
</div>
<script>
function formatUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  return h + 'h ' + m + 'm';
}
function escapeHtml(t) {
  var d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}
async function refresh() {
  try {
    var data = await fetch('/status').then(function(r) { return r.json(); });
    var grid = document.getElementById('agents');
    if (data.agents && data.agents.length > 0) {
      grid.innerHTML = data.agents.map(function(a) {
        return '<div class="card ' + a.status + '">' +
          '<div class="role">' + escapeHtml(a.role) + '</div>' +
          '<div class="model">' + escapeHtml(a.model) + '</div>' +
          '<span class="status-badge ' + a.status + '">' + a.status + '</span>' +
          '<div class="task">' + (a.currentTask ? escapeHtml(a.currentTask) : 'No active task') + '</div>' +
          '</div>';
      }).join('');
    } else {
      grid.innerHTML = '<div class="empty">No agents configured</div>';
    }
    document.getElementById('queue').textContent = data.queue ? data.queue.length : 0;
    document.getElementById('uptime').textContent = formatUptime(data.uptime || 0);
    document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
  } catch (e) {
    console.error('Failed to fetch status:', e);
  }
  try {
    var events = await fetch('/events?limit=15').then(function(r) { return r.json(); });
    var act = document.getElementById('activity');
    if (events && events.length > 0) {
      act.innerHTML = events.map(function(ev) {
        var time = ev.created_at ? new Date(ev.created_at + 'Z').toLocaleString() : '';
        return '<div class="activity-row">' +
          '<span class="time">' + escapeHtml(time) + '</span>' +
          '<span class="agent">' + escapeHtml(ev.agent_type || '') + '</span>' +
          '<span class="event-type">' + escapeHtml(ev.event_type || '') + '</span>' +
          '<span class="issue">' + escapeHtml(ev.issue_key || '') + '</span>' +
          '</div>';
      }).join('');
    } else {
      act.innerHTML = '<div class="empty">No recent events</div>';
    }
  } catch (e) {
    console.error('Failed to fetch events:', e);
  }
}
async function refreshSwarms() {
  try {
    var data = await fetch('/swarm-status').then(function(r) { return r.json(); });
    var section = document.getElementById('swarm-section');
    var container = document.getElementById('swarms');
    if (data.swarms && data.swarms.length > 0) {
      section.style.display = 'block';
      container.innerHTML = data.swarms.map(function(s) {
        var deltaStr = s.baseline !== null && s.bestMetric !== null
          ? (s.higherIsBetter ? '+' : '') + (s.bestMetric - s.baseline).toFixed(4)
          : 'N/A';
        var agentsHtml = s.agents.map(function(a) {
          var pct = Math.round((a.experiments / a.maxExperiments) * 100);
          return '<div class="swarm-agent">' +
            '<span class="dot ' + (a.alive ? 'green' : '') + '" style="background:' + (a.alive ? '#3fb950' : '#484f58') + '"></span>' +
            '<span>Agent ' + a.index + ' (' + escapeHtml(a.focus) + ')</span>' +
            '<span style="margin-left:auto;color:#484f58;">' + a.experiments + '/' + a.maxExperiments + '</span>' +
            '<div class="progress-bar" style="max-width:80px;"><div class="fill" style="width:' + pct + '%;"></div></div>' +
            '</div>';
        }).join('');
        var expsHtml = s.recentExperiments.map(function(e) {
          var cls = e.outcome;
          var icon = e.outcome === 'improvement' ? '&#9650;' :
                     e.outcome === 'regression' ? '&#9660;' :
                     e.outcome === 'error' ? '&#10007;' : '&#8212;';
          return '<div class="swarm-exp"><span class="' + cls + '">' + icon + '</span> ' +
            escapeHtml(e.id) + ': ' + escapeHtml(e.hypothesis.substring(0, 60)) +
            ' (' + escapeHtml(s.metric) + '=' + (e.metricValue !== null ? e.metricValue : 'N/A') + ')' +
            '</div>';
        }).join('');
        return '<div class="swarm-card">' +
          '<div class="swarm-header">' +
            '<span class="swarm-name">' + escapeHtml(s.name) + '</span>' +
            '<span class="swarm-metric">' + escapeHtml(s.metric) + ' (' + (s.higherIsBetter ? '&#8593;' : '&#8595;') + ')</span>' +
          '</div>' +
          '<div class="swarm-stats">' +
            '<div class="stat"><span class="stat-label">Baseline</span><span class="stat-value">' + (s.baseline !== null ? s.baseline : '&mdash;') + '</span></div>' +
            '<div class="stat"><span class="stat-label">Best</span><span class="stat-value">' + (s.bestMetric !== null ? s.bestMetric : '&mdash;') + '</span></div>' +
            '<div class="stat"><span class="stat-label">Delta</span><span class="stat-value">' + deltaStr + '</span></div>' +
            '<div class="stat"><span class="stat-label">Experiments</span><span class="stat-value">' + s.totalExperiments + '</span></div>' +
            '<div class="stat"><span class="stat-label">Frontier</span><span class="stat-value">' + s.frontierSize + ' ideas</span></div>' +
          '</div>' +
          '<div class="swarm-agents">' + agentsHtml + '</div>' +
          (expsHtml ? '<div class="swarm-exps">' + expsHtml + '</div>' : '') +
          '</div>';
      }).join('');
    } else {
      section.style.display = 'none';
    }
  } catch (e) {
    // Swarm endpoint may not exist yet
  }
}
setInterval(refresh, 10000);
setInterval(refreshSwarms, 10000);
refresh();
refreshSwarms();
</script>
</body>
</html>`;
}

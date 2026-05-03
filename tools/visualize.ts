#!/usr/bin/env npx tsx
/**
 * Knowledge Graph Visualizer
 *
 * Queries the DB for entities and facts, generates a self-contained
 * HTML file with an interactive force-directed graph, and opens it.
 *
 * Usage:
 *   npx tsx tools/visualize.ts
 *   npx tsx tools/visualize.ts --group default
 *   npx tsx tools/visualize.ts --open false
 */

import postgres from 'postgres';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const DB_URL = process.env.DATABASE_URL || 'postgresql://brain:brain@localhost:5432/company_brain';

const args = process.argv.slice(2);
const groupIdx = args.indexOf('--group');
const groupId = groupIdx >= 0 ? args[groupIdx + 1] : null;
const shouldOpen = !args.includes('--open') || args[args.indexOf('--open') + 1] !== 'false';

async function main() {
  const sql = postgres(DB_URL, { max: 1 });

  // Fetch entities
  const entities = groupId
    ? await sql`SELECT id, name, entity_type, summary FROM entities WHERE group_id = ${groupId}`
    : await sql`SELECT id, name, entity_type, summary FROM entities`;

  // Fetch current facts
  const facts = groupId
    ? await sql`
        SELECT f.id, f.source_entity_id, f.target_entity_id, f.relation, f.fact_text, f.confidence
        FROM facts f
        WHERE f.group_id = ${groupId} AND f.invalid_at IS NULL`
    : await sql`
        SELECT f.id, f.source_entity_id, f.target_entity_id, f.relation, f.fact_text, f.confidence
        FROM facts f
        WHERE f.invalid_at IS NULL`;

  await sql.end();

  if (entities.length === 0) {
    console.error('No entities found in the database. Ingest some data first.');
    process.exit(1);
  }

  // Build graph data
  const entityIds = new Set(entities.map(e => e.id));
  const nodes = entities.map(e => ({
    id: e.id,
    name: e.name,
    type: e.entity_type,
    summary: (e.summary || '').slice(0, 300),
  }));

  const links = facts
    .filter(f => entityIds.has(f.source_entity_id) && entityIds.has(f.target_entity_id))
    .map(f => ({
      source: f.source_entity_id,
      target: f.target_entity_id,
      relation: f.relation,
      text: f.fact_text,
      confidence: Number(f.confidence),
    }));

  const graphData = JSON.stringify({ nodes, links });

  const html = buildHtml(graphData, nodes.length, links.length, groupId);
  const outPath = resolve(process.cwd(), 'graph.html');
  writeFileSync(outPath, html);
  console.log(`Graph written to ${outPath} (${nodes.length} entities, ${links.length} facts)`);

  if (shouldOpen) {
    try {
      execSync(`open "${outPath}"`);
    } catch {
      console.log('Open the file manually in your browser.');
    }
  }
}

function buildHtml(graphData: string, nodeCount: number, linkCount: number, group: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Company Brain — Knowledge Graph</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: #000000;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
    background-size: 40px 40px;
    background-position: -1px -1px;
    color: #EDEDED;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    overflow: hidden;
  }

  /* ─── Header ─── */
  #header {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 10;
    padding: 12px 20px;
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid #222;
    display: flex;
    align-items: center;
    gap: 16px;
  }

  #header .logo {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  #header .logo-icon {
    width: 24px; height: 24px;
    background: #fff;
    color: #000;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  #header h1 {
    font-size: 14px;
    font-weight: 600;
    color: #EDEDED;
    letter-spacing: -0.01em;
  }

  #header .stats {
    font-size: 12px;
    color: #888;
    font-weight: 400;
    padding-left: 12px;
    border-left: 1px solid #333;
  }

  #header .controls {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }

  #header button {
    background: transparent;
    border: 1px solid #333;
    color: #A0A0A0;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    transition: all 0.15s ease;
  }

  #header button:hover {
    background: #111;
    color: #EDEDED;
    border-color: #444;
  }

  #header button.active {
    background: #EDEDED;
    border-color: #EDEDED;
    color: #000;
  }

  /* ─── Search ─── */
  #search-box {
    position: fixed;
    top: 60px; left: 50%;
    transform: translateX(-50%) translateY(-10px);
    z-index: 15;
    opacity: 0;
    pointer-events: none;
    transition: all 0.2s ease;
  }

  #search-box.visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
    pointer-events: all;
  }

  #search-box input {
    width: 320px;
    padding: 10px 14px 10px 34px;
    background: #111;
    border: 1px solid #333;
    border-radius: 8px;
    color: #EDEDED;
    font-size: 13px;
    font-family: inherit;
    outline: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }

  #search-box input:focus {
    border-color: #666;
  }

  #search-box .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: #666;
  }

  /* ─── Tooltip ─── */
  #tooltip {
    position: fixed;
    pointer-events: none;
    background: #111;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 12px;
    max-width: 320px;
    z-index: 20;
    display: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }

  #tooltip .tt-name {
    font-weight: 600;
    font-size: 14px;
    color: #EDEDED;
    margin-bottom: 4px;
  }

  #tooltip .tt-type {
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
    color: #A0A0A0;
  }

  #tooltip .tt-summary {
    font-size: 12px;
    color: #A0A0A0;
    line-height: 1.5;
    margin-bottom: 8px;
  }

  #tooltip .tt-divider {
    height: 1px;
    background: #333;
    margin: 8px 0;
  }

  #tooltip .tt-conn-header {
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    color: #666;
    margin-bottom: 6px;
  }

  #tooltip .tt-fact {
    font-size: 11px;
    color: #888;
    line-height: 1.4;
    margin-bottom: 4px;
  }

  #tooltip .tt-fact .tt-rel {
    color: #EDEDED;
    font-weight: 500;
  }

  /* ─── Detail Panel ─── */
  #detail-panel {
    position: fixed;
    top: 51px;
    right: 0;
    bottom: 0;
    width: 320px;
    background: #0A0A0A;
    border-left: 1px solid #222;
    z-index: 12;
    padding: 24px;
    overflow-y: auto;
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  #detail-panel.open {
    transform: translateX(0);
  }

  #detail-panel .dp-close {
    position: absolute;
    top: 16px; right: 16px;
    background: transparent;
    border: none;
    color: #666;
    cursor: pointer;
    font-size: 20px;
    padding: 4px;
    line-height: 1;
  }

  #detail-panel .dp-close:hover { color: #EDEDED; }

  #detail-panel .dp-name {
    font-size: 18px;
    font-weight: 600;
    color: #EDEDED;
    margin-bottom: 4px;
    padding-right: 24px;
  }

  #detail-panel .dp-type {
    font-size: 11px;
    font-weight: 500;
    color: #A0A0A0;
    margin-bottom: 16px;
  }

  #detail-panel .dp-summary {
    font-size: 13px;
    color: #A0A0A0;
    line-height: 1.6;
    margin-bottom: 24px;
  }

  #detail-panel .dp-section {
    font-size: 11px;
    font-weight: 500;
    color: #666;
    margin: 24px 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #222;
  }

  #detail-panel .dp-fact {
    font-size: 12px;
    color: #888;
    margin-bottom: 12px;
    line-height: 1.5;
  }

  #detail-panel .dp-fact span {
    color: #EDEDED;
    font-weight: 500;
  }

  #detail-panel .dp-conn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    font-size: 13px;
    color: #A0A0A0;
    cursor: pointer;
    border-bottom: 1px solid #111;
  }

  #detail-panel .dp-conn:hover { color: #EDEDED; }

  #detail-panel .dp-conn-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ─── Legend ─── */
  #legend {
    position: fixed;
    bottom: 24px;
    left: 24px;
    background: #111;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 16px;
    font-size: 12px;
    z-index: 10;
  }

  #legend .legend-title {
    font-size: 10px;
    font-weight: 500;
    color: #666;
    margin-bottom: 12px;
  }

  #legend .item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    color: #A0A0A0;
    cursor: pointer;
  }

  #legend .item:hover { color: #EDEDED; }
  #legend .item.muted { opacity: 0.3; }

  #legend .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ─── SVG ─── */
  svg#graph { width: 100vw; height: 100vh; position: relative; z-index: 1; }

  .link-line {
    stroke: #333;
    stroke-width: 1px;
    transition: stroke 0.2s, opacity 0.2s;
  }

  .link-line.highlighted {
    stroke: #888;
  }

  .node circle {
    cursor: pointer;
    transition: all 0.2s;
  }

  .node text {
    font-size: 11px;
    font-weight: 500;
    fill: #A0A0A0;
    pointer-events: none;
    transition: opacity 0.2s;
  }

  .node.dimmed circle { opacity: 0.1; }
  .node.dimmed text { opacity: 0; }
  .link-line.dimmed { opacity: 0.1; }

  .node.highlighted circle {
    stroke: #fff;
    stroke-width: 2px;
  }

  .node.highlighted text {
    fill: #EDEDED;
  }

  .node.search-match circle {
    stroke: #fff;
    stroke-width: 3px;
  }

  /* ─── Kbd hint ─── */
  #kbd-hint {
    position: fixed;
    bottom: 24px;
    right: 24px;
    font-size: 12px;
    color: #666;
    z-index: 10;
  }

  #kbd-hint kbd {
    display: inline-block;
    padding: 2px 6px;
    background: #111;
    border: 1px solid #333;
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    color: #A0A0A0;
  }
</style>
</head>
<body>

<div id="header">
  <div class="logo">
    <div class="logo-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
    </div>
    <h1>Company Brain</h1>
  </div>
  <span class="stats">${nodeCount} entities &middot; ${linkCount} relationships${group ? ` &middot; ${group}` : ''}</span>
  <div class="controls">
    <button id="btn-search" title="Cmd+F">Search</button>
    <button id="btn-labels" class="active">Labels</button>
    <button id="btn-reset">Reset</button>
  </div>
</div>

<div id="search-box">
  <span class="search-icon">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
  </span>
  <input type="text" id="search-input" placeholder="Search entities..." autocomplete="off" spellcheck="false">
</div>

<div id="tooltip"></div>

<div id="detail-panel">
  <button class="dp-close">&times;</button>
  <div id="dp-content"></div>
</div>

<div id="legend"></div>

<div id="kbd-hint">
  <kbd>Cmd</kbd> + <kbd>F</kbd> to search &middot; scroll to zoom
</div>

<svg id="graph"></svg>

<script>
const graph = ${graphData};

// ─── Color system ───
// A more refined, slightly muted but distinct color palette
const typeConfig = {
  person:          '#4E89FF', // Blue
  company:         '#00C97B', // Green
  project:         '#FF8A00', // Orange
  decision:        '#FF3E3E', // Red
  concept:         '#B566FF', // Purple
  event:           '#FFD166', // Yellow
  document:        '#A1A1AA', // Slate
  deal:            '#00D4C5', // Teal
  feature_request: '#FF64B4', // Pink
};

function getColor(type) {
  return typeConfig[type] || '#888888';
}

function getTypeLabel(type) {
  return type.replace(/_/g, ' ');
}

// ─── Precompute connection counts ───
const connCount = {};
graph.nodes.forEach(n => { connCount[n.id] = 0; });
graph.links.forEach(l => {
  const sid = typeof l.source === 'object' ? l.source.id : l.source;
  const tid = typeof l.target === 'object' ? l.target.id : l.target;
  connCount[sid] = (connCount[sid] || 0) + 1;
  connCount[tid] = (connCount[tid] || 0) + 1;
});

function renderFallbackGraph() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const svgEl = document.getElementById('graph');
  const ns = 'http://www.w3.org/2000/svg';
  const nodesById = new Map(graph.nodes.map(n => [n.id, n]));
  const activeTypes = new Set([...new Set(graph.nodes.map(n => n.type))]);
  const connectedLinks = graph.links
    .map(l => ({ ...l, source: nodesById.get(l.source), target: nodesById.get(l.target) }))
    .filter(l => l.source && l.target);
  let selectedNode = null;
  let showLabels = true;
  let transform = { x: 0, y: 0, k: 1 };

  svgEl.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  const viewport = document.createElementNS(ns, 'g');
  svgEl.appendChild(viewport);

  const layoutRadius = Math.min(width, height) * 0.24;
  graph.nodes.forEach((node, index) => {
    const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
    node.x = width / 2 + Math.cos(angle) * layoutRadius;
    node.y = height / 2 + Math.sin(angle) * layoutRadius;
    node.vx = 0;
    node.vy = 0;
  });

  for (let step = 0; step < 260; step++) {
    for (let i = 0; i < graph.nodes.length; i++) {
      for (let j = i + 1; j < graph.nodes.length; j++) {
        const a = graph.nodes[i];
        const b = graph.nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = Math.min(2.2, 650 / (dist * dist));
        dx /= dist;
        dy /= dist;
        a.vx -= dx * force;
        a.vy -= dy * force;
        b.vx += dx * force;
        b.vy += dy * force;
      }
    }

    connectedLinks.forEach(link => {
      const desired = 120;
      let dx = link.target.x - link.source.x;
      let dy = link.target.y - link.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - desired) * 0.012;
      dx /= dist;
      dy /= dist;
      link.source.vx += dx * force;
      link.source.vy += dy * force;
      link.target.vx -= dx * force;
      link.target.vy -= dy * force;
    });

    graph.nodes.forEach(node => {
      node.vx += (width / 2 - node.x) * 0.004;
      node.vy += (height / 2 - node.y) * 0.004;
      node.vx *= 0.86;
      node.vy *= 0.86;
      node.x = Math.max(90, Math.min(width - 90, node.x + node.vx));
      node.y = Math.max(95, Math.min(height - 70, node.y + node.vy));
    });
  }

  const lineEls = connectedLinks.map(link => {
    const line = document.createElementNS(ns, 'line');
    line.classList.add('link-line');
    line.__data = link;
    viewport.appendChild(line);
    return line;
  });

  const nodeEls = graph.nodes.map(node => {
    const group = document.createElementNS(ns, 'g');
    group.classList.add('node');
    group.__data = node;
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('r', String(getFallbackRadius(node)));
    circle.setAttribute('fill', getColor(node.type));
    circle.setAttribute('stroke', '#000');
    circle.setAttribute('stroke-width', '2');
    const label = document.createElementNS(ns, 'text');
    label.textContent = node.name;
    label.setAttribute('dx', String(getFallbackRadius(node) + 8));
    label.setAttribute('dy', '4');
    group.append(circle, label);
    viewport.appendChild(group);

    group.addEventListener('mouseenter', event => {
      if (selectedNode) return;
      const conns = linksFor(node);
      highlightNode(node, conns);
      showTooltip(event, node, conns);
    });
    group.addEventListener('mousemove', event => {
      if (!selectedNode) positionTooltip(event);
    });
    group.addEventListener('mouseleave', () => {
      if (selectedNode) return;
      clearHighlight();
      tooltip.style.display = 'none';
    });
    group.addEventListener('click', event => {
      event.stopPropagation();
      selectNode(node);
    });
    return group;
  });

  renderLegend();
  draw();

  function getFallbackRadius(node) {
    return Math.max(8, Math.min(25, 8 + (connCount[node.id] || 0) * 2.2));
  }

  function draw() {
    viewport.setAttribute('transform', 'translate(' + transform.x + ' ' + transform.y + ') scale(' + transform.k + ')');
    lineEls.forEach(line => {
      const link = line.__data;
      line.setAttribute('x1', link.source.x);
      line.setAttribute('y1', link.source.y);
      line.setAttribute('x2', link.target.x);
      line.setAttribute('y2', link.target.y);
    });
    nodeEls.forEach(group => {
      const node = group.__data;
      group.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
    });
  }

  function renderLegend() {
    const types = [...activeTypes].sort();
    const legend = document.getElementById('legend');
    legend.innerHTML = '<div class="legend-title">Entity Types</div>' + types.map(type => {
      const count = graph.nodes.filter(node => node.type === type).length;
      return '<div class="item" data-type="' + type + '"><div class="dot" style="background:' + getColor(type) + '"></div><span>' + getTypeLabel(type) + '</span><span style="margin-left:auto;opacity:0.4;font-size:11px">' + count + '</span></div>';
    }).join('');
    legend.querySelectorAll('.item').forEach(item => {
      item.addEventListener('click', () => {
        const type = item.dataset.type;
        const disabled = item.classList.toggle('muted');
        if (disabled) activeTypes.delete(type);
        else activeTypes.add(type);
        applyTypeFilter();
      });
    });
  }

  function applyTypeFilter() {
    nodeEls.forEach(group => group.classList.toggle('dimmed', !activeTypes.has(group.__data.type)));
    lineEls.forEach(line => line.classList.toggle('dimmed', !activeTypes.has(line.__data.source.type) || !activeTypes.has(line.__data.target.type)));
  }

  function linksFor(node) {
    return connectedLinks.filter(link => link.source.id === node.id || link.target.id === node.id);
  }

  function highlightNode(node, conns) {
    const ids = new Set([node.id]);
    conns.forEach(link => { ids.add(link.source.id); ids.add(link.target.id); });
    nodeEls.forEach(group => {
      group.classList.toggle('dimmed', !ids.has(group.__data.id));
      group.classList.toggle('highlighted', ids.has(group.__data.id) && group.__data.id !== node.id);
    });
    lineEls.forEach(line => {
      const active = line.__data.source.id === node.id || line.__data.target.id === node.id;
      line.classList.toggle('dimmed', !active);
      line.classList.toggle('highlighted', active);
    });
  }

  function clearHighlight() {
    nodeEls.forEach(group => group.classList.remove('dimmed', 'highlighted', 'search-match'));
    lineEls.forEach(line => line.classList.remove('dimmed', 'highlighted'));
    applyTypeFilter();
  }

  const tooltip = document.getElementById('tooltip');
  const detailPanel = document.getElementById('detail-panel');
  const dpContent = document.getElementById('dp-content');
  detailPanel.querySelector('.dp-close').addEventListener('click', deselectAll);

  function showTooltip(event, node, conns) {
    let html = '<div class="tt-name">' + escHtml(node.name) + '</div>';
    html += '<div class="tt-type" style="color:' + getColor(node.type) + '">' + getTypeLabel(node.type) + '</div>';
    if (node.summary) html += '<div class="tt-summary">' + escHtml(node.summary) + '</div>';
    if (conns.length > 0) {
      html += '<div class="tt-divider"></div><div class="tt-conn-header">' + conns.length + ' relationship' + (conns.length !== 1 ? 's' : '') + '</div>';
      conns.slice(0, 4).forEach(link => {
        html += '<div class="tt-fact"><span class="tt-rel">' + escHtml(link.relation.replace(/_/g, ' ')) + '</span> - ' + escHtml(link.text.slice(0, 100)) + '</div>';
      });
    }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    positionTooltip(event);
  }

  function positionTooltip(event) {
    const pad = 16;
    const rect = tooltip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY - 10;
    if (x + rect.width > window.innerWidth - 20) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 20) y = window.innerHeight - rect.height - 20;
    tooltip.style.left = x + 'px';
    tooltip.style.top = Math.max(60, y) + 'px';
  }

  function selectNode(node) {
    selectedNode = node;
    tooltip.style.display = 'none';
    const conns = linksFor(node);
    highlightNode(node, conns);
    let html = '<div class="dp-name">' + escHtml(node.name) + '</div>';
    html += '<div class="dp-type" style="color:' + getColor(node.type) + '">' + getTypeLabel(node.type) + '</div>';
    if (node.summary) html += '<div class="dp-summary">' + escHtml(node.summary) + '</div>';
    html += '<div class="dp-section">Relationships (' + conns.length + ')</div>';
    conns.forEach(link => {
      html += '<div class="dp-fact"><span>' + escHtml(link.relation.replace(/_/g, ' ')) + '</span><br>' + escHtml(link.text) + '</div>';
    });
    dpContent.innerHTML = html;
    detailPanel.classList.add('open');
  }

  function deselectAll() {
    selectedNode = null;
    detailPanel.classList.remove('open');
    tooltip.style.display = 'none';
    clearHighlight();
  }

  document.getElementById('btn-reset').addEventListener('click', () => {
    transform = { x: 0, y: 0, k: 1 };
    deselectAll();
    draw();
  });

  document.getElementById('btn-labels').addEventListener('click', function() {
    showLabels = !showLabels;
    nodeEls.forEach(group => group.querySelector('text').style.display = showLabels ? 'block' : 'none');
    this.classList.toggle('active', showLabels);
  });

  const searchBox = document.getElementById('search-box');
  const searchInput = document.getElementById('search-input');
  document.getElementById('btn-search').addEventListener('click', toggleSearch);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault();
      toggleSearch();
    }
    if (event.key === 'Escape') {
      searchBox.classList.remove('visible');
      searchInput.value = '';
      clearHighlight();
    }
  });
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) return clearHighlight();
    const matches = new Set(graph.nodes.filter(node => node.name.toLowerCase().includes(q) || node.type.includes(q) || (node.summary && node.summary.toLowerCase().includes(q))).map(node => node.id));
    const expanded = new Set(matches);
    connectedLinks.forEach(link => {
      if (matches.has(link.source.id)) expanded.add(link.target.id);
      if (matches.has(link.target.id)) expanded.add(link.source.id);
    });
    nodeEls.forEach(group => {
      group.classList.toggle('search-match', matches.has(group.__data.id));
      group.classList.toggle('dimmed', !expanded.has(group.__data.id));
    });
    lineEls.forEach(line => line.classList.toggle('dimmed', !matches.has(line.__data.source.id) && !matches.has(line.__data.target.id)));
  });

  function toggleSearch() {
    searchBox.classList.toggle('visible');
    if (searchBox.classList.contains('visible')) searchInput.focus();
    else {
      searchInput.value = '';
      clearHighlight();
    }
  }

  let dragStart = null;
  svgEl.addEventListener('click', event => {
    if (event.target === svgEl) deselectAll();
  });
  svgEl.addEventListener('wheel', event => {
    event.preventDefault();
    const next = Math.max(0.25, Math.min(4, transform.k * (event.deltaY > 0 ? 0.9 : 1.1)));
    const mx = event.clientX;
    const my = event.clientY;
    transform.x = mx - ((mx - transform.x) / transform.k) * next;
    transform.y = my - ((my - transform.y) / transform.k) * next;
    transform.k = next;
    draw();
  }, { passive: false });
  svgEl.addEventListener('pointerdown', event => {
    if (event.target !== svgEl) return;
    dragStart = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
    svgEl.setPointerCapture(event.pointerId);
  });
  svgEl.addEventListener('pointermove', event => {
    if (!dragStart) return;
    transform.x = dragStart.tx + event.clientX - dragStart.x;
    transform.y = dragStart.ty + event.clientY - dragStart.y;
    draw();
  });
  svgEl.addEventListener('pointerup', () => { dragStart = null; });
}

if (!window.d3) {
  renderFallbackGraph();
} else {

// ─── Legend ───
const types = [...new Set(graph.nodes.map(n => n.type))].sort();
const legend = document.getElementById('legend');
const activeTypes = new Set(types);

function renderLegend() {
  legend.innerHTML = '<div class="legend-title">Entity Types</div>' + types.map(t => {
    const count = graph.nodes.filter(n => n.type === t).length;
    const muted = !activeTypes.has(t) ? ' muted' : '';
    return '<div class="item' + muted + '" data-type="' + t + '"><div class="dot" style="background:' + getColor(t) + '"></div><span>' + getTypeLabel(t) + '</span> <span style="margin-left:auto;opacity:0.4;font-size:11px">' + count + '</span></div>';
  }).join('');

  legend.querySelectorAll('.item').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.dataset.type;
      if (activeTypes.has(type)) activeTypes.delete(type);
      else activeTypes.add(type);
      renderLegend();
      applyTypeFilter();
    });
  });
}

function applyTypeFilter() {
  node.classed('dimmed', d => !activeTypes.has(d.type));
  node.select('circle').style('pointer-events', d => activeTypes.has(d.type) ? 'all' : 'none');
  linkLine.classed('dimmed', d => !activeTypes.has(d.source.type) || !activeTypes.has(d.target.type));
}

renderLegend();

// ─── D3 Graph ───
const width = window.innerWidth;
const height = window.innerHeight;
const layoutRadius = Math.min(width, height) * 0.28;

graph.nodes.forEach((node, index) => {
  const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
  node.x = width / 2 + Math.cos(angle) * layoutRadius;
  node.y = height / 2 + Math.sin(angle) * layoutRadius;
});

const svg = d3.select('svg#graph')
  .attr('viewBox', [0, 0, width, height]);

const container = svg.append('g');

const zoomBehavior = d3.zoom()
  .scaleExtent([0.1, 8])
  .on('zoom', (e) => container.attr('transform', e.transform));

svg.call(zoomBehavior);

svg.on('click', (event) => {
  if (event.target.tagName === 'svg' || event.target.tagName === 'SVG') {
    deselectAll();
  }
});

const simulation = d3.forceSimulation(graph.nodes)
  .force('link', d3.forceLink(graph.links).id(d => d.id).distance(100).strength(0.5))
  .force('charge', d3.forceManyBody().strength(-300).distanceMax(600))
  .force('center', d3.forceCenter(width / 2, height / 2).strength(0.05))
  .force('collision', d3.forceCollide().radius(d => getRadius(d) + 16))
  .force('x', d3.forceX(width / 2).strength(0.03))
  .force('y', d3.forceY(height / 2).strength(0.03))
  .alphaDecay(0.02);

function getRadius(d) {
  const c = connCount[d.id] || 0;
  return Math.max(7, Math.min(24, 7 + c * 2.2));
}

// Links
const linkLine = container.append('g')
  .selectAll('line')
  .data(graph.links)
  .join('line')
  .attr('class', 'link-line');

// Nodes
const node = container.append('g')
  .selectAll('g')
  .data(graph.nodes)
  .join('g')
  .attr('class', 'node')
  .call(d3.drag()
    .on('start', dragstarted)
    .on('drag', dragged)
    .on('end', dragended));

// Clean, solid circles with a dark stroke to separate from grid
node.append('circle')
  .attr('r', d => getRadius(d))
  .attr('fill', d => getColor(d.type))
  .attr('stroke', '#000')
  .attr('stroke-width', 2);

// Labels
let showLabels = true;
const labels = node.append('text')
  .text(d => d.name)
  .attr('dx', d => getRadius(d) + 8)
  .attr('dy', 4);

// ─── Tooltip ───
const tooltip = document.getElementById('tooltip');

node.on('mouseover', (event, d) => {
  if (selectedNode) return;

  const conns = graph.links.filter(l => l.source.id === d.id || l.target.id === d.id);
  const connectedIds = new Set([d.id]);
  conns.forEach(l => { connectedIds.add(l.source.id); connectedIds.add(l.target.id); });

  node.classed('dimmed', n => !connectedIds.has(n.id));
  node.classed('highlighted', n => connectedIds.has(n.id) && n.id !== d.id);
  linkLine.classed('dimmed', l => l.source.id !== d.id && l.target.id !== d.id);
  linkLine.classed('highlighted', l => l.source.id === d.id || l.target.id === d.id);

  showTooltip(event, d, conns);
})
.on('mousemove', (event) => {
  if (selectedNode) return;
  positionTooltip(event);
})
.on('mouseout', () => {
  if (selectedNode) return;
  node.classed('dimmed', false).classed('highlighted', false);
  linkLine.classed('dimmed', false).classed('highlighted', false);
  tooltip.style.display = 'none';
})
.on('click', (event, d) => {
  event.stopPropagation();
  selectNode(d);
});

linkLine.on('mouseover', (event, d) => {
  if (selectedNode) return;
  let html = '<div class="tt-name">' + escHtml(d.relation.replace(/_/g, ' ')) + '</div>';
  html += '<div class="tt-summary">' + escHtml(d.text) + '</div>';
  html += '<div style="margin-top:8px;font-size:11px;color:#666">Confidence: ' + Math.round(d.confidence * 100) + '%</div>';
  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  positionTooltip(event);
})
.on('mousemove', (event) => { if (!selectedNode) positionTooltip(event); })
.on('mouseout', () => { if (!selectedNode) tooltip.style.display = 'none'; });

function showTooltip(event, d, conns) {
  let html = '<div class="tt-name">' + escHtml(d.name) + '</div>';
  html += '<div class="tt-type" style="color:' + getColor(d.type) + '">' + getTypeLabel(d.type) + '</div>';
  if (d.summary) html += '<div class="tt-summary">' + escHtml(d.summary) + '</div>';
  if (conns.length > 0) {
    html += '<div class="tt-divider"></div>';
    html += '<div class="tt-conn-header">' + conns.length + ' relationship' + (conns.length !== 1 ? 's' : '') + '</div>';
    conns.slice(0, 4).forEach(c => {
      html += '<div class="tt-fact"><span class="tt-rel">' + escHtml(c.relation.replace(/_/g, ' ')) + '</span> &mdash; ' + escHtml(c.text.slice(0, 100)) + '</div>';
    });
    if (conns.length > 4) html += '<div style="font-size:11px;color:#666;margin-top:6px">+' + (conns.length - 4) + ' more</div>';
  }
  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  positionTooltip(event);
}

function positionTooltip(event) {
  const pad = 16;
  let x = event.clientX + pad;
  let y = event.clientY - 10;
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 20) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 20) y = window.innerHeight - rect.height - 20;
  if (y < 60) y = 60;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

// ─── Detail Panel ───
let selectedNode = null;
const detailPanel = document.getElementById('detail-panel');
const dpContent = document.getElementById('dp-content');

detailPanel.querySelector('.dp-close').addEventListener('click', deselectAll);

function selectNode(d) {
  selectedNode = d;
  tooltip.style.display = 'none';

  const conns = graph.links.filter(l => l.source.id === d.id || l.target.id === d.id);
  const connectedIds = new Set([d.id]);
  conns.forEach(l => { connectedIds.add(l.source.id); connectedIds.add(l.target.id); });

  node.classed('dimmed', n => !connectedIds.has(n.id));
  node.classed('highlighted', n => connectedIds.has(n.id) && n.id !== d.id);
  linkLine.classed('dimmed', l => l.source.id !== d.id && l.target.id !== d.id);
  linkLine.classed('highlighted', l => l.source.id === d.id || l.target.id === d.id);

  let html = '<div class="dp-name">' + escHtml(d.name) + '</div>';
  html += '<div class="dp-type" style="color:' + getColor(d.type) + '">' + getTypeLabel(d.type) + '</div>';
  if (d.summary) html += '<div class="dp-summary">' + escHtml(d.summary) + '</div>';

  if (conns.length > 0) {
    html += '<div class="dp-section">Relationships (' + conns.length + ')</div>';
    conns.forEach(c => {
      html += '<div class="dp-fact"><span>' + escHtml(c.relation.replace(/_/g, ' ')) + '</span><br>' + escHtml(c.text) + '</div>';
    });
  }

  const connNodes = graph.nodes.filter(n => connectedIds.has(n.id) && n.id !== d.id);
  if (connNodes.length > 0) {
    html += '<div class="dp-section">Connected Entities (' + connNodes.length + ')</div>';
    connNodes.forEach(n => {
      html += '<div class="dp-conn" data-id="' + n.id + '"><div class="dp-conn-dot" style="background:' + getColor(n.type) + '"></div>' + escHtml(n.name) + ' <span style="opacity:0.5;margin-left:auto;font-size:11px">' + getTypeLabel(n.type) + '</span></div>';
    });
  }

  dpContent.innerHTML = html;
  detailPanel.classList.add('open');

  dpContent.querySelectorAll('.dp-conn').forEach(el => {
    el.addEventListener('click', () => {
      const target = graph.nodes.find(n => n.id === el.dataset.id);
      if (target) selectNode(target);
    });
  });
}

function deselectAll() {
  selectedNode = null;
  detailPanel.classList.remove('open');
  node.classed('dimmed', false).classed('highlighted', false).classed('search-match', false);
  linkLine.classed('dimmed', false).classed('highlighted', false);
  tooltip.style.display = 'none';
}

// ─── Search ───
const searchBox = document.getElementById('search-box');
const searchInput = document.getElementById('search-input');

document.getElementById('btn-search').addEventListener('click', toggleSearch);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    toggleSearch();
  }
  if (e.key === 'Escape') {
    searchBox.classList.remove('visible');
    searchInput.value = '';
    node.classed('search-match', false).classed('dimmed', false);
    linkLine.classed('dimmed', false);
  }
});

function toggleSearch() {
  searchBox.classList.toggle('visible');
  if (searchBox.classList.contains('visible')) {
    searchInput.focus();
  } else {
    searchInput.value = '';
    node.classed('search-match', false).classed('dimmed', false);
    linkLine.classed('dimmed', false);
  }
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase().trim();
  if (!q) {
    node.classed('search-match', false).classed('dimmed', false);
    linkLine.classed('dimmed', false);
    return;
  }
  const matchIds = new Set();
  graph.nodes.forEach(n => {
    if (n.name.toLowerCase().includes(q) || n.type.includes(q) || (n.summary && n.summary.toLowerCase().includes(q))) {
      matchIds.add(n.id);
    }
  });
  const expandedIds = new Set(matchIds);
  graph.links.forEach(l => {
    if (matchIds.has(l.source.id)) expandedIds.add(l.target.id);
    if (matchIds.has(l.target.id)) expandedIds.add(l.source.id);
  });
  node.classed('search-match', n => matchIds.has(n.id));
  node.classed('dimmed', n => !expandedIds.has(n.id));
  linkLine.classed('dimmed', l => !matchIds.has(l.source.id) && !matchIds.has(l.target.id));
});

// ─── Tick ───
function renderFrame() {
  linkLine
    .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
}

simulation.tick(120);
renderFrame();
simulation.on('tick', renderFrame);

// ─── Drag ───
function dragstarted(event) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  event.subject.fx = event.subject.x;
  event.subject.fy = event.subject.y;
}
function dragged(event) {
  event.subject.fx = event.x;
  event.subject.fy = event.y;
}
function dragended(event) {
  if (!event.active) simulation.alphaTarget(0);
  event.subject.fx = null;
  event.subject.fy = null;
}

// ─── Controls ───
document.getElementById('btn-reset').addEventListener('click', () => {
  svg.transition().duration(500).ease(d3.easeCubicInOut).call(zoomBehavior.transform, d3.zoomIdentity);
  deselectAll();
});

document.getElementById('btn-labels').addEventListener('click', function() {
  showLabels = !showLabels;
  labels.style('display', showLabels ? 'block' : 'none');
  this.classList.toggle('active', showLabels);
});

}

// ─── Utility ───
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
</script>
</body>
</html>`;
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
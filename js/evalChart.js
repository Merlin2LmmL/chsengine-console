export function renderEvalChart(container, points, width = 720, height = 280, opts = {}) {
  // Filter to selected/opened game only (points have gameId)
  const selectedId = (typeof window !== 'undefined' && window.selectedGameId) ? window.selectedGameId : null;
  const pts = selectedId ? points.filter(p => p.gameId === selectedId) : points;
  const displayPoints = pts.length ? pts : (selectedId ? [] : points);

  // Always center y-axis at 0, symmetric around it
  const yMode = opts.yMode || 'fixed';
  let yMax, yMin;
  if (displayPoints.length > 0) {
    const cps = displayPoints.filter(p => p.cp != null).map(p => p.cp);
    const minC = cps.length ? Math.min(...cps) : 0;
    const maxC = cps.length ? Math.max(...cps) : 0;
    if (yMode === 'dynamic') {
      const absMax = Math.max(Math.abs(minC), Math.abs(maxC), 50);
      const rounded = Math.ceil(absMax / 100) * 100;
      yMax = rounded;
      yMin = -rounded;
    } else {
      const fixedVal = Math.abs(opts.yFixed || 300);
      yMax = fixedVal;
      yMin = -fixedVal;
    }
  } else {
    yMax = 300;
    yMin = -300;
  }

  const pad = { top: 24, right: 30, bottom: 36, left: 70 };
  const w = Math.max(0, width - pad.left - pad.right);
  const h = Math.max(0, height - pad.top - pad.bottom);

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";

  // Background
  const bg = document.createElementNS(svgNS, "rect");
  bg.setAttribute("x", 0);
  bg.setAttribute("y", 0);
  bg.setAttribute("width", width);
  bg.setAttribute("height", height);
  bg.setAttribute("fill", "#fafbfc");
  svg.appendChild(bg);

  // Grid lines
  const lineCount = 5;
  for (let i = 0; i <= lineCount; i++) {
    const val = yMin + (i / lineCount) * (yMax - yMin);
    const y = pad.top + h - ((val - yMin) / (yMax - yMin)) * h;
    const gridLine = document.createElementNS(svgNS, "line");
    gridLine.setAttribute("x1", pad.left);
    gridLine.setAttribute("y1", y);
    gridLine.setAttribute("x2", pad.left + w);
    gridLine.setAttribute("y2", y);
    gridLine.setAttribute("stroke", val === 0 ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.08)");
    gridLine.setAttribute("stroke-width", val === 0 ? 2 : 1);
    svg.appendChild(gridLine);
  }

  // Zero line label
  const zeroLine = document.createElementNS(svgNS, "line");
  zeroLine.setAttribute("x1", pad.left);
  zeroLine.setAttribute("y1", pad.top + h - ((0 - yMin) / (yMax - yMin)) * h);
  zeroLine.setAttribute("x2", pad.left + w);
  zeroLine.setAttribute("y2", pad.top + h - ((0 - yMin) / (yMax - yMin)) * h);
  zeroLine.setAttribute("stroke", "#333");
  zeroLine.setAttribute("stroke-width", 2);
  svg.appendChild(zeroLine);

  const zeroLabel = document.createElementNS(svgNS, "text");
  zeroLabel.setAttribute("x", pad.left - 8);
  zeroLabel.setAttribute("y", (pad.top + h - ((0 - yMin) / (yMax - yMin)) * h) + 4);
  zeroLabel.setAttribute("font-size", "16");
  zeroLabel.setAttribute("font-weight", "bold");
  zeroLabel.setAttribute("fill", "#222");
  zeroLabel.setAttribute("text-anchor", "end");
  zeroLabel.textContent = "0";
  svg.appendChild(zeroLabel);

  // Only max/min labels, readable size
  // Max label at top
  const maxLabel = document.createElementNS(svgNS, "text");
  maxLabel.setAttribute("x", pad.left - 8);
  maxLabel.setAttribute("y", pad.top + 16);
  maxLabel.setAttribute("font-size", "16");
  maxLabel.setAttribute("font-weight", "600");
  maxLabel.setAttribute("fill", "#1a7");
  maxLabel.setAttribute("text-anchor", "end");
  maxLabel.textContent = `+${yMax}`;
  svg.appendChild(maxLabel);

  // Min label at bottom
  const minLabel = document.createElementNS(svgNS, "text");
  minLabel.setAttribute("x", pad.left - 8);
  minLabel.setAttribute("y", pad.top + h + 16);
  minLabel.setAttribute("font-size", "16");
  minLabel.setAttribute("font-weight", "600");
  minLabel.setAttribute("fill", "#c22");
  minLabel.setAttribute("text-anchor", "end");
  minLabel.textContent = `${yMin}`;
  svg.appendChild(minLabel);

  // Axis line (y-axis)
  const yAxis = document.createElementNS(svgNS, "line");
  yAxis.setAttribute("x1", pad.left);
  yAxis.setAttribute("y1", pad.top);
  yAxis.setAttribute("x2", pad.left);
  yAxis.setAttribute("y2", pad.top + h);
  yAxis.setAttribute("stroke", "#ccc");
  yAxis.setAttribute("stroke-width", 1);
  svg.appendChild(yAxis);

  // X-axis line
  const xAxis = document.createElementNS(svgNS, "line");
  xAxis.setAttribute("x1", pad.left);
  xAxis.setAttribute("y1", pad.top + h);
  xAxis.setAttribute("x2", pad.left + w);
  xAxis.setAttribute("y2", pad.top + h);
  xAxis.setAttribute("stroke", "#ccc");
  xAxis.setAttribute("stroke-width", 1);
  svg.appendChild(xAxis);

  // Polyline for points
  if (displayPoints.length > 1) {
    const ptsStr = displayPoints.map((p, i) => {
      const x = pad.left + (i / Math.max(displayPoints.length - 1, 1)) * w;
      const yVal = p.mateIn ? (p.mateIn > 0 ? pad.top + 10 : pad.top + h - 10) : (p.cp != null ? p.cp : 0);
      const y = pad.top + h - ((yVal - yMin) / (yMax - yMin)) * h;
      return `${x},${y}`;
    }).join(" ");
    const poly = document.createElementNS(svgNS, "polyline");
    poly.setAttribute("points", ptsStr);
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", "#2a7");
    poly.setAttribute("stroke-width", 2.5);
    poly.setAttribute("stroke-linecap", "round");
    poly.setAttribute("stroke-linejoin", "round");
    svg.appendChild(poly);
  }

  // Points dots
  displayPoints.forEach((p, i) => {
    if (p.mateIn) return; // handled separately
    if (displayPoints.length <= 1 && i === 0) {
      // single point: just draw dot
    }
    const x = displayPoints.length <= 1 ? pad.left + w / 2 : pad.left + (i / Math.max(displayPoints.length - 1, 1)) * w;
    const yVal = p.cp != null ? p.cp : 0;
    const y = pad.top + h - ((yVal - yMin) / (yMax - yMin)) * h;
    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", 4);
    dot.setAttribute("fill", "#2a7");
    dot.setAttribute("stroke", "#fff");
    dot.setAttribute("stroke-width", 1.5);
    svg.appendChild(dot);
  });

  // Checkmate labels
  displayPoints.forEach((p, i) => {
    if (p.mateIn) {
      const x = displayPoints.length <= 1 ? pad.left + w / 2 : pad.left + (i / Math.max(displayPoints.length - 1, 1)) * w;
      const yVal = p.mateIn > 0 ? 50 : -50; // approximate position near top/bottom
      const y = p.mateIn > 0 ? pad.top + 14 : pad.top + h - 14;
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", x);
      text.setAttribute("y", y);
      text.setAttribute("font-size", "13");
      text.setAttribute("font-weight", "bold");
      text.setAttribute("fill", p.mateIn > 0 ? "#c00" : "#c00");
      text.setAttribute("text-anchor", "middle");
      text.textContent = p.mateIn > 0 ? `M${p.mateIn}` : `M-${p.mateIn}`;
      svg.appendChild(text);
    }
  });

  // Title area with point count
  const title = document.createElementNS(svgNS, "text");
  title.setAttribute("x", width / 2);
  title.setAttribute("y", 14);
  title.setAttribute("font-size", "12");
  title.setAttribute("font-weight", "bold");
  title.setAttribute("fill", "#555");
  title.setAttribute("text-anchor", "middle");
  title.textContent = `Eval — ${displayPoints.length} move(s)`;
  svg.appendChild(title);

  // Empty state message
  if (displayPoints.length === 0) {
    const msg = document.createElementNS(svgNS, "text");
    msg.setAttribute("x", width / 2);
    msg.setAttribute("y", height / 2);
    msg.setAttribute("font-size", "14");
    msg.setAttribute("fill", "#888");
    msg.setAttribute("text-anchor", "middle");
    msg.textContent = selectedId ? "No eval data for selected game" : "No eval points yet";
    svg.appendChild(msg);
  }

  container.innerHTML = "";
  container.appendChild(svg);
}

export function openChartModal(points, opts = {}) {
  let m = document.getElementById('eval-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'eval-modal';
    m.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const innerStyle = 'background:#fff;color:#000;padding:12px;border-radius:8px;width:95vw;height:95vh;max-width:none;max-height:none;overflow:hidden;display:flex;flex-direction:column;';
    const inner = document.createElement('div');
    inner.style.cssText = innerStyle;
    m.appendChild(inner);
    document.body.appendChild(m);
    inner.innerHTML = '<button onclick="document.getElementById(\'eval-modal\').remove()" style="float:right">Close</button><div id="eval-modal-chart" style="margin-top:30px;flex:1;min-height:0;"></div>';
  }
  renderEvalChart(document.getElementById('eval-modal-chart'), points, 900, 380, opts);
}

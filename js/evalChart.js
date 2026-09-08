export function renderEvalChart(container, points, width=720, height=280, opts={}) {
  // opts: {yMode:'dynamic'|'fixed', yFixed:300}
  const yMode = opts.yMode || 'fixed';
  let yMin, yMax;
  if (yMode === 'dynamic' && points.length > 0) {
    const cps = points.filter(p => p.cp != null).map(p => p.cp);
    const minC = cps.length ? Math.min(...cps) : -300;
    const maxC = cps.length ? Math.max(...cps) : 300;
    yMin = Math.floor(minC/100)*100 - 100;
    yMax = Math.ceil(maxC/100)*100 + 100;
    if (yMin > -300) yMin = -300; if (yMax < 300) yMax = 300;
  } else {
    yMin = -300; yMax = opts.yFixed || 300;
  }
  const pad = {top:20, right:20, bottom:30, left:50};
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.width = "100%"; svg.style.height = "auto";
  // axes
  const axis = document.createElementNS(svgNS, "line");
  axis.setAttribute("x1", pad.left); axis.setAttribute("y1", pad.top + h/2);
  axis.setAttribute("x2", pad.left + w); axis.setAttribute("y2", pad.top + h/2);
  axis.setAttribute("stroke", "#ccc");
  svg.appendChild(axis);
  // y labels
  for (let v = Math.round(yMin/100)*100; v <= Math.round(yMax/100)*100; v += 100) {
    const y = pad.top + h - ((v - yMin) / (yMax - yMin)) * h;
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", pad.left - 8); text.setAttribute("y", y + 3);
    text.setAttribute("font-size", "10"); text.setAttribute("fill", "#555");
    text.textContent = v;
    svg.appendChild(text);
  }
  // polyline
  if (points.length > 1) {
    const pts = points.map((p, i) => {
      const x = pad.left + (i / (points.length - 1)) * w;
      const y = p.mateIn ? (p.mateIn > 0 ? pad.top + 10 : pad.top + h - 10) : pad.top + h - ((p.cp - yMin) / (yMax - yMin)) * h;
      return `${x},${y}`;
    }).join(" ");
    const poly = document.createElementNS(svgNS, "polyline");
    poly.setAttribute("points", pts);
    poly.setAttribute("fill", "none"); poly.setAttribute("stroke", "#2a7"); poly.setAttribute("stroke-width", "2");
    svg.appendChild(poly);
  }
  // checkmate labels
  points.forEach((p, i) => {
    if (p.mateIn) {
      const x = pad.left + (i / Math.max(points.length - 1, 1)) * w;
      const y = p.mateIn > 0 ? pad.top + 10 : pad.top + h - 10;
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", x); text.setAttribute("y", y - 5);
      text.setAttribute("font-size", "11"); text.setAttribute("fill", "#c00"); text.setAttribute("font-weight", "bold");
      text.textContent = `M${p.mateIn}`;
      svg.appendChild(text);
    }
  });
  container.innerHTML = ""; container.appendChild(svg);
}
export function openChartModal(points, opts={}) {
  let m = document.getElementById('eval-modal');
  if (!m) {
    m = document.createElement('div'); m.id='eval-modal';
    m.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const inner = document.createElement('div'); inner.style.cssText = 'background:#fff;color:#000;padding:20px;border-radius:8px;max-width:92%;max-height:92vh;overflow:auto;';
    m.appendChild(inner); document.body.appendChild(m);
    inner.innerHTML = '<button onclick="document.getElementById(\'eval-modal\').remove()" style="float:right">Close</button><div id="eval-modal-chart" style="margin-top:30px;"></div>';
  }
  renderEvalChart(document.getElementById('eval-modal-chart'), points, 900, 380, opts);
}

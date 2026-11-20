const SVG_NS = "http://www.w3.org/2000/svg";

const TONE_PALETTE = {
  idle: {
    fill: "#ffffff",
    stroke: "#d5dce6",
    badgeFill: "#f1f5f9",
    badgeDot: "#94a3b8",
    title: "#334155",
    sub: "#64748b",
  },
  active: {
    fill: "#eef2ff",
    stroke: "#4f46e5",
    badgeFill: "#e0e7ff",
    badgeDot: "#4f46e5",
    title: "#1e1b4b",
    sub: "#4338ca",
  },
  done: {
    fill: "#ffffff",
    stroke: "#34d399",
    badgeFill: "#ecfdf5",
    badgeDot: "#059669",
    title: "#0f172a",
    sub: "#047857",
  },
  warn: {
    fill: "#fffbeb",
    stroke: "#f59e0b",
    badgeFill: "#fef3c7",
    badgeDot: "#d97706",
    title: "#78350f",
    sub: "#b45309",
  },
  error: {
    fill: "#fff1f2",
    stroke: "#fb7185",
    badgeFill: "#ffe4e6",
    badgeDot: "#e11d48",
    title: "#881337",
    sub: "#be123c",
  },
};

const EDGE_COLORS = {
  idle: "#cbd5e1",
  active: "#4f46e5",
  done: "#10b981",
  warn: "#d97706",
  error: "#e11d48",
};

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) {
      node.setAttribute(k, String(v));
    }
  }
  return node;
}

function buildBezierPath(fromNode, toNode) {
  const x1 = fromNode.x + (fromNode.w || 156);
  const y1 = fromNode.y + (fromNode.h || 56) / 2;
  const x2 = toNode.x;
  const y2 = toNode.y + (toNode.h || 56) / 2;
  const dx = Math.max(36, (x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * Render an interactive SVG execution flow diagram.
 * @param {HTMLElement} container
 * @param {{ viewBox?: string, nodes: Array, edges: Array }} graph
 */
export function renderFlowchart(container, graph) {
  container.innerHTML = "";
  const svg = el("svg", {
    viewBox: graph.viewBox || "0 0 920 206",
    class: "flow-svg",
    role: "img",
    "aria-label": "任务执行实时流程图",
  });

  const defs = el("defs");
  const shadow = el("filter", { id: "flow-card-shadow", x: "-8%", y: "-12%", width: "116%", height: "130%" });
  shadow.appendChild(
    el("feDropShadow", {
      dx: "0",
      dy: "2",
      stdDeviation: "3",
      "flood-color": "#0f172a",
      "flood-opacity": "0.06",
    })
  );
  defs.appendChild(shadow);

  for (const [tone, color] of Object.entries(EDGE_COLORS)) {
    const marker = el("marker", {
      id: `arrow-${tone}`,
      viewBox: "0 0 10 10",
      refX: "8.5",
      refY: "5",
      markerWidth: "6",
      markerHeight: "6",
      orient: "auto-start-reverse",
    });
    marker.appendChild(
      el("path", {
        d: "M 1 1.5 L 8.5 5 L 1 8.5 z",
        fill: color,
      })
    );
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // Draw edges first
  const edgeGroup = el("g", { class: "flow-edges" });
  for (const edge of graph.edges) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) continue;

    const tone = edge.tone || "idle";
    const d = buildBezierPath(from, to);

    // Base track
    edgeGroup.appendChild(
      el("path", {
        d,
        fill: "none",
        stroke: tone === "idle" ? EDGE_COLORS.idle : EDGE_COLORS[tone],
        "stroke-width": tone === "idle" ? "1.6" : "2.1",
        "stroke-opacity": tone === "idle" ? "0.85" : "1",
        "stroke-dasharray": tone === "active" ? "6 5" : undefined,
        class: tone === "active" ? "flow-edge-animated" : undefined,
        "marker-end": `url(#arrow-${tone})`,
      })
    );

    if (edge.label) {
      const mx = (from.x + (from.w || 156) + to.x) / 2;
      const my = (from.y + (from.h || 56) / 2 + to.y + (to.h || 56) / 2) / 2;
      const pillW = Math.max(44, Math.round(edge.label.length * 7.2 + 12));
      edgeGroup.appendChild(
        el("rect", {
          x: mx - pillW / 2,
          y: my - 9,
          width: pillW,
          height: 17,
          rx: 5,
          fill: "#ffffff",
          stroke: tone === "idle" ? "#e2e8f0" : EDGE_COLORS[tone],
          "stroke-width": "1",
        })
      );
      const labelText = el("text", {
        x: mx,
        y: my + 3.5,
        "text-anchor": "middle",
        fill: tone === "idle" ? "#64748b" : EDGE_COLORS[tone],
        "font-size": "10",
        "font-weight": "600",
        class: "flow-edge-label",
      });
      labelText.textContent = edge.label;
      edgeGroup.appendChild(labelText);
    }
  }
  svg.appendChild(edgeGroup);

  // Draw nodes
  const nodeGroup = el("g", { class: "flow-nodes" });
  for (const node of graph.nodes) {
    const w = node.w || 156;
    const h = node.h || 56;
    const tone = node.tone || "idle";
    const palette = TONE_PALETTE[tone] || TONE_PALETTE.idle;

    const g = el("g", {
      transform: `translate(${node.x}, ${node.y})`,
      class: `flow-node flow-node--${tone}`,
    });

    if (tone === "active") {
      g.appendChild(
        el("rect", {
          x: -3,
          y: -3,
          width: w + 6,
          height: h + 6,
          rx: 13,
          fill: "none",
          stroke: "#6366f1",
          "stroke-opacity": "0.28",
          "stroke-width": "3",
        })
      );
    }

    g.appendChild(
      el("rect", {
        x: 0,
        y: 0,
        width: w,
        height: h,
        rx: 10,
        fill: palette.fill,
        stroke: palette.stroke,
        "stroke-width": tone === "idle" ? "1.2" : "1.75",
        filter: "url(#flow-card-shadow)",
      })
    );

    // Status indicator pill on top-left inside card
    g.appendChild(
      el("circle", {
        cx: 16,
        cy: 20,
        r: 7,
        fill: palette.badgeFill,
      })
    );
    g.appendChild(
      el("circle", {
        cx: 16,
        cy: 20,
        r: 3.4,
        fill: palette.badgeDot,
        class: tone === "active" ? "flow-dot-pulse" : undefined,
      })
    );

    const title = el("text", {
      x: 29,
      y: 24,
      fill: palette.title,
      "font-size": "12.5",
      "font-weight": "600",
    });
    title.textContent = node.title;
    g.appendChild(title);

    const sub = el("text", {
      x: 14,
      y: 43,
      fill: palette.sub,
      "font-size": "10.8",
      class: "flow-node-sub",
    });
    sub.textContent = node.sub || "";
    g.appendChild(sub);

    nodeGroup.appendChild(g);
  }
  svg.appendChild(nodeGroup);
  container.appendChild(svg);
}

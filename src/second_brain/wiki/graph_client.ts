/**
 * Browser runtime for the generated graph explorer.
 *
 * It intentionally has no package/runtime dependency: the static wiki must
 * remain usable from file://. The renderer keeps graph topology fixed and
 * continuously interpolates positions, opacity, labels, and aggregate edges
 * from camera scale, which avoids stepped zoom modes and expensive graph swaps.
 */
export const GRAPH_EXPLORER_SCRIPT = String.raw`
(function () {
  "use strict";

  var data = window.__SECOND_BRAIN_GRAPH__;
  var canvas = document.getElementById("thought-graph");
  var shell = document.querySelector(".graph-shell");
  if (!data || !canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!ctx) return;

  var TYPE_LABELS = ["Teze", "Otázka", "Téma", "Tenze", "Vlákno"];
  var TYPE_COLORS = ["#63d5b5", "#62c9ef", "#b78cff", "#ef7fa7", "#ffb45d"];
  var STATUS_LABELS = ["aktivní", "pracovní", "neuzavřené", "revidované"];
  var RELATION_LABELS = [
    "sémantická blízkost",
    "podpora",
    "spoluvýskyt",
    "tenze",
    "revize",
    "nahrazení",
    "kontextové rozdělení"
  ];
  var RELATION_COLORS = [
    "#78918a",
    "#62d0a4",
    "#667771",
    "#ef7797",
    "#e0b768",
    "#f19367",
    "#9f91d9"
  ];

  var dpr = 1;
  var width = 0;
  var height = 0;
  var baseScale = 1;
  var selected = -1;
  var hovered = -1;
  var hoveredCluster = -1;
  var selectedNeighbors = new Set();
  var selectedEdges = [];
  var activeTypes = data.nodeTypes.map(function () { return true; });
  var activeRelations = data.relationTypes.map(function () { return true; });
  var sx = new Float32Array(data.nodes.length);
  var sy = new Float32Array(data.nodes.length);
  var visibility = new Float32Array(data.nodes.length);
  var clusterSalienceRank = new Uint16Array(data.nodes.length);
  var hitNodes = [];
  var hitClusters = [];
  var pointer = { x: -1000, y: -1000, down: false, moved: false, startX: 0, startY: 0, lastX: 0, lastY: 0 };
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var motionEnergy = reducedMotion ? 0 : 1;
  var quality = 1;
  var labelLimit = 70;
  var edgeStride = 2;
  var frameCount = 0;
  var fpsStarted = performance.now();
  var lastTime = performance.now();
  var camera = { x: 0, y: 0, zoom: 1 };
  var targetCamera = { x: 0, y: 0, zoom: 1 };
  var compactChrome = false;
  var nodeInteractionZoom = 2.08;

  // A global salience threshold makes a constellation with one exceptional
  // node look as if its heading was renamed during zoom. Rank nodes inside
  // their own constellation so several local landmarks can emerge together.
  var nodesByCluster = data.clusters.map(function () { return []; });
  for (var rankIndex = 0; rankIndex < data.nodes.length; rankIndex += 1) {
    nodesByCluster[data.nodes[rankIndex].cluster].push(rankIndex);
  }
  nodesByCluster.forEach(function (members) {
    members.sort(function (left, right) {
      return data.nodes[right].salience - data.nodes[left].salience || left - right;
    });
    members.forEach(function (nodeIndex, rank) {
      clusterSalienceRank[nodeIndex] = Math.min(65535, rank);
    });
  });

  // Reuse one compact adjacency index for click selection and pointer hover.
  // Building it once avoids scanning all 28k edges on every pointer move.
  var edgesByNode = data.nodes.map(function () { return []; });
  for (var adjacencyIndex = 0; adjacencyIndex < data.edges.length; adjacencyIndex += 1) {
    var adjacencyEdge = data.edges[adjacencyIndex];
    edgesByNode[adjacencyEdge[0]].push(adjacencyEdge);
    edgesByNode[adjacencyEdge[1]].push(adjacencyEdge);
  }
  edgesByNode.forEach(function (edges) {
    edges.sort(function (left, right) { return right[3] - left[3]; });
  });

  var panel = document.getElementById("node-panel");
  var panelKicker = document.getElementById("node-panel-kicker");
  var panelTitle = document.getElementById("node-panel-title");
  var panelSummary = document.getElementById("node-panel-summary");
  var panelMeta = document.getElementById("node-panel-meta");
  var panelLink = document.getElementById("node-panel-link");
  var searchInput = document.getElementById("graph-search");
  var searchResults = document.getElementById("graph-search-results");
  var performanceLabel = document.getElementById("graph-performance");

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function mix(from, to, amount) {
    return from + (to - from) * amount;
  }

  function smoothstep(from, to, value) {
    var progress = clamp((value - from) / Math.max(0.0001, to - from), 0, 1);
    return progress * progress * (3 - 2 * progress);
  }

  function easeCamera() {
    var ease = reducedMotion ? 1 : 0.14;
    camera.x = mix(camera.x, targetCamera.x, ease);
    camera.y = mix(camera.y, targetCamera.y, ease);
    camera.zoom = mix(camera.zoom, targetCamera.zoom, ease);
    if (Math.abs(camera.x - targetCamera.x) < 0.0005) camera.x = targetCamera.x;
    if (Math.abs(camera.y - targetCamera.y) < 0.0005) camera.y = targetCamera.y;
    if (Math.abs(camera.zoom - targetCamera.zoom) < 0.0005) camera.zoom = targetCamera.zoom;
  }

  function resize() {
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, quality < 1 ? 1.15 : 1.6);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var graphWidth = Math.max(1, data.bounds.maxX - data.bounds.minX);
    var graphHeight = Math.max(1, data.bounds.maxY - data.bounds.minY);
    baseScale = Math.min((width * 0.78) / graphWidth, (height * 0.74) / graphHeight);
    if (!Number.isFinite(baseScale) || baseScale <= 0) baseScale = 1;
  }

  function screenPosition(x, y) {
    return {
      x: width * 0.5 + (x - camera.x) * baseScale * camera.zoom,
      y: height * 0.52 + (y - camera.y) * baseScale * camera.zoom
    };
  }

  function worldPosition(screenX, screenY, useTarget) {
    var source = useTarget ? targetCamera : camera;
    return {
      x: source.x + (screenX - width * 0.5) / (baseScale * source.zoom),
      y: source.y + (screenY - height * 0.52) / (baseScale * source.zoom)
    };
  }

  function morphAmount() {
    return smoothstep(0.76, 3.55, camera.zoom);
  }

  function projectNodes(now) {
    var morph = morphAmount();
    var energy = motionEnergy * (1 - morph * 0.45);
    hitNodes.length = 0;
    for (var index = 0; index < data.nodes.length; index += 1) {
      var node = data.nodes[index];
      var cluster = data.clusters[node.cluster];
      var reveal = smoothstep(node.reveal - 0.48, node.reveal + 0.52, camera.zoom);
      if (!activeTypes[node.type]) reveal *= 0.04;
      var angle = index * 2.399963 + now * 0.00042;
      var drift = energy * (0.8 + (index % 7) * 0.12);
      var x = mix(cluster.x, node.x, morph) + Math.cos(angle) * drift;
      var y = mix(cluster.y, node.y, morph) + Math.sin(angle * 1.13) * drift;
      var projected = screenPosition(x, y);
      sx[index] = projected.x;
      sy[index] = projected.y;
      visibility[index] = reveal;
      if (reveal > 0.16 && projected.x > -24 && projected.x < width + 24 && projected.y > -24 && projected.y < height + 24) {
        hitNodes.push(index);
      }
    }
    return morph;
  }

  function lineVisible(x1, y1, x2, y2) {
    return !(
      (x1 < -30 && x2 < -30) ||
      (x1 > width + 30 && x2 > width + 30) ||
      (y1 < -30 && y2 < -30) ||
      (y1 > height + 30 && y2 > height + 30)
    );
  }

  function drawBackdrop() {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    var spacing = clamp(70 * camera.zoom, 46, 110);
    var offsetX = ((-camera.x * baseScale * camera.zoom) % spacing + spacing) % spacing;
    var offsetY = ((-camera.y * baseScale * camera.zoom) % spacing + spacing) % spacing;
    ctx.strokeStyle = "rgba(198, 220, 210, 0.025)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = offsetX; x < width; x += spacing) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    for (var y = offsetY; y < height; y += spacing) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    ctx.stroke();
    ctx.restore();
  }

  function drawClusterEdges(morph) {
    var alpha = (1 - smoothstep(0.8, 3.15, camera.zoom)) * 0.7;
    if (alpha < 0.01) return;
    ctx.save();
    ctx.lineCap = "round";
    var maxCount = data.clusterEdges.length ? data.clusterEdges[0].count : 1;
    var hoveredLabels = [];
    for (var index = 0; index < data.clusterEdges.length; index += 1) {
      var edge = data.clusterEdges[index];
      if (!activeRelations[edge.dominantType]) continue;
      var incident = hoveredCluster >= 0 && (edge.source === hoveredCluster || edge.target === hoveredCluster);
      var source = screenPosition(data.clusters[edge.source].x, data.clusters[edge.source].y);
      var target = screenPosition(data.clusters[edge.target].x, data.clusters[edge.target].y);
      if (!lineVisible(source.x, source.y, target.x, target.y)) continue;
      var strength = Math.sqrt(edge.count / Math.max(1, maxCount));
      var focusAlpha = hoveredCluster < 0 ? 1 : incident ? 1.45 : 0.16;
      ctx.strokeStyle = hexToRgba(RELATION_COLORS[edge.dominantType], alpha * focusAlpha * (0.12 + strength * 0.3));
      ctx.lineWidth = 0.55 + strength * (incident ? 4.8 : 3.25);
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.quadraticCurveTo((source.x + target.x) * 0.5, (source.y + target.y) * 0.5 - 14 * strength, target.x, target.y);
      ctx.stroke();
      if (incident && camera.zoom < 2.25 && hoveredLabels.length < 6) {
        hoveredLabels.push({
          x: (source.x + target.x) * 0.5,
          y: (source.y + target.y) * 0.5 - 8,
          label: RELATION_LABELS[edge.dominantType] + " · " + edge.count + " vztahů"
        });
      }
    }
    var labelBoxes = [];
    ctx.font = "700 9px Avenir Next, Segoe UI, sans-serif";
    for (var labelIndex = 0; labelIndex < hoveredLabels.length; labelIndex += 1) {
      var label = hoveredLabels[labelIndex];
      var labelWidth = ctx.measureText(label.label).width + 12;
      var labelBox = { x: label.x - labelWidth * 0.5, y: label.y - 9, width: labelWidth, height: 18 };
      var overlaps = labelBoxes.some(function (box) {
        return !(labelBox.x + labelBox.width + 6 < box.x || labelBox.x > box.x + box.width + 6 || labelBox.y + labelBox.height + 5 < box.y || labelBox.y > box.y + box.height + 5);
      });
      if (overlaps) continue;
      drawEdgeLabel(label.x, label.y, label.label, alpha * 0.96);
      labelBoxes.push(labelBox);
    }
    ctx.restore();
  }

  function drawActualEdges(morph) {
    var baseAlpha = smoothstep(1.34, 3.85, camera.zoom);
    if (baseAlpha < 0.012) return;
    ctx.save();
    ctx.lineCap = "round";
    var selectedMode = selected >= 0;
    var detailStride = camera.zoom < 4.8 ? 4 : 2;
    var stride = selectedMode ? 1 : Math.max(edgeStride, detailStride);
    for (var index = 0; index < data.edges.length; index += stride) {
      var edge = data.edges[index];
      var sourceIndex = edge[0];
      var targetIndex = edge[1];
      var type = edge[2];
      if (!activeRelations[type] || visibility[sourceIndex] < 0.06 || visibility[targetIndex] < 0.06) continue;
      if (!activeTypes[data.nodes[sourceIndex].type] || !activeTypes[data.nodes[targetIndex].type]) continue;
      var isSelectedEdge = selectedMode && (sourceIndex === selected || targetIndex === selected);
      if (selectedMode && !isSelectedEdge) continue;
      var x1 = sx[sourceIndex];
      var y1 = sy[sourceIndex];
      var x2 = sx[targetIndex];
      var y2 = sy[targetIndex];
      if (!lineVisible(x1, y1, x2, y2)) continue;
      if (!selectedMode) {
        var margin = 55;
        var sourceOnScreen = x1 > -margin && x1 < width + margin && y1 > -margin && y1 < height + margin;
        var targetOnScreen = x2 > -margin && x2 < width + margin && y2 > -margin && y2 < height + margin;
        if (!sourceOnScreen || !targetOnScreen) continue;
      }
      var alpha = isSelectedEdge ? 0.82 : baseAlpha * 0.026 * Math.min(1, visibility[sourceIndex] * visibility[targetIndex]);
      ctx.strokeStyle = hexToRgba(RELATION_COLORS[type], alpha);
      ctx.lineWidth = isSelectedEdge ? 1.2 + Math.min(2.4, Math.log2(1 + edge[3])) : 0.45 + Math.min(1.1, Math.log2(1 + edge[3]) * 0.16);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    var focusEdges = selectedMode ? selectedEdges : hovered >= 0 ? edgesByNode[hovered] : [];
    if (focusEdges.length) {
      var shown = 0;
      var hoverDrawn = 0;
      var edgeLabelBoxes = [];
      var focusLimit = selectedMode ? 18 : 4;
      var hoverEdgeLimit = quality < 0.8 ? 10 : quality < 1 ? 16 : 24;
      ctx.font = "700 9px Avenir Next, Segoe UI, sans-serif";
      for (var focusIndex = 0; focusIndex < focusEdges.length; focusIndex += 1) {
        if (selectedMode && shown >= focusLimit) break;
        if (!selectedMode && hoverDrawn >= hoverEdgeLimit) break;
        var focusEdge = focusEdges[focusIndex];
        if (!activeRelations[focusEdge[2]]) continue;
        if (!activeTypes[data.nodes[focusEdge[0]].type] || !activeTypes[data.nodes[focusEdge[1]].type]) continue;
        if (visibility[focusEdge[0]] < 0.06 || visibility[focusEdge[1]] < 0.06) continue;
        var ex1 = sx[focusEdge[0]];
        var ey1 = sy[focusEdge[0]];
        var ex2 = sx[focusEdge[1]];
        var ey2 = sy[focusEdge[1]];
        if (!lineVisible(ex1, ey1, ex2, ey2)) continue;
        var focusAlpha = selectedMode ? 0.9 : 0.58 * smoothstep(1.92, 2.2, camera.zoom);
        if (!selectedMode) {
          ctx.strokeStyle = hexToRgba(RELATION_COLORS[focusEdge[2]], focusAlpha);
          ctx.lineWidth = 0.85 + Math.min(1.25, Math.log2(1 + focusEdge[3]) * 0.34);
          ctx.beginPath();
          ctx.moveTo(ex1, ey1);
          ctx.lineTo(ex2, ey2);
          ctx.stroke();
          hoverDrawn += 1;
        }
        if (shown < focusLimit) {
          var edgeLabel = RELATION_LABELS[focusEdge[2]];
          var labelX = (ex1 + ex2) * 0.5;
          var labelY = (ey1 + ey2) * 0.5;
          var labelWidth = ctx.measureText(edgeLabel).width + 12;
          var labelBox = { x: labelX - labelWidth * 0.5, y: labelY - 9, width: labelWidth, height: 18 };
          var labelOverlaps = edgeLabelBoxes.some(function (box) {
            return !(labelBox.x + labelBox.width + 5 < box.x || labelBox.x > box.x + box.width + 5 || labelBox.y + labelBox.height + 4 < box.y || labelBox.y > box.y + box.height + 4);
          });
          if (!labelOverlaps) {
            drawEdgeLabel(labelX, labelY, edgeLabel, focusAlpha);
            edgeLabelBoxes.push(labelBox);
          }
          shown += 1;
        }
      }
    }
    ctx.restore();
  }

  function drawClusters(morph) {
    var alpha = 1 - smoothstep(1.22, 3.38, camera.zoom);
    hitClusters.length = 0;
    if (alpha < 0.01) return;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (var index = 0; index < data.clusters.length; index += 1) {
      var cluster = data.clusters[index];
      if (!cluster.count) continue;
      var point = screenPosition(cluster.x, cluster.y);
      var viewportBubbleScale = clamp(Math.min(width / 900, height / 700), 0.52, 1);
      var radius = clamp(31 + Math.sqrt(cluster.count) * 0.62, 34, 72) * viewportBubbleScale * (1 - morph * 0.56);
      if (point.x < -radius || point.x > width + radius || point.y < -radius || point.y > height + radius) continue;
      var pulse = reducedMotion ? 0 : Math.sin(performance.now() * 0.0011 + index) * motionEnergy * 1.4;
      var gradient = ctx.createRadialGradient(point.x - radius * 0.2, point.y - radius * 0.25, 2, point.x, point.y, radius + pulse);
      gradient.addColorStop(0, hexToRgba(cluster.color, alpha * 0.42));
      gradient.addColorStop(0.72, hexToRgba(cluster.color, alpha * 0.19));
      gradient.addColorStop(1, hexToRgba(cluster.color, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 13 + pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hexToRgba("#0c1715", 0.88 * alpha);
      ctx.strokeStyle = hexToRgba(cluster.color, 0.58 * alpha);
      ctx.lineWidth = hoveredCluster === index ? 2.2 : 1.1;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      var compactCluster = width < 600;
      var displayTitle = compactCluster ? truncateText(cluster.title, 24) : cluster.title;
      var lines = splitClusterTitle(displayTitle, compactCluster ? 13 : 20, compactCluster ? 2 : 3);
      var titleAlpha = alpha * (1 - smoothstep(1.38, 1.94, camera.zoom));
      ctx.fillStyle = hexToRgba("#f2f5ef", titleAlpha);
      var clusterFontSize = compactCluster ? clamp(8.5 + radius * 0.045, 9, 11) : clamp(10 + radius * 0.075, 11, 15);
      ctx.font = "600 " + clusterFontSize + "px Avenir Next, Segoe UI, sans-serif";
      for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        ctx.fillText(lines[lineIndex], point.x, point.y + (lineIndex - (lines.length - 1) * 0.5) * (clusterFontSize + 1) - (compactCluster ? 2 : 4));
      }
      ctx.fillStyle = hexToRgba(cluster.color, titleAlpha * 0.95);
      ctx.font = "800 " + (compactCluster ? 7.5 : 9) + "px Avenir Next, Segoe UI, sans-serif";
      ctx.fillText(formatNumber(cluster.count) + (compactCluster ? "" : " NODŮ"), point.x, point.y + radius * 0.56);
      hitClusters.push({ index: index, x: point.x, y: point.y, radius: radius });
    }
    ctx.restore();
  }

  function drawClusterHeadings() {
    var headingPhase = smoothstep(1.62, 2.28, camera.zoom);
    // Canvas labels must also respect the HTML chrome floating above it.
    var occupied = width < 600
      ? [
          { x: 0, y: 0, width: width, height: 105 },
          { x: 0, y: height - 245, width: width, height: 245 }
        ]
      : [
          { x: 0, y: 0, width: 410, height: 76 },
          { x: width - 270, y: 0, width: 270, height: 78 },
          { x: 0, y: height - 235, width: 420, height: 235 },
          { x: width - 78, y: height - 190, width: 78, height: 190 }
        ];
    if (headingPhase < 0.015) return occupied;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (var index = 0; index < data.clusters.length; index += 1) {
      var cluster = data.clusters[index];
      if (!cluster.count) continue;
      // This is a spatial label of the expanding region, not a fixed HUD
      // title. It therefore follows the constellation and can leave the
      // viewport naturally when the user pans or zooms deeper into one part.
      var point = screenPosition(cluster.x, cluster.y - cluster.radius * 0.68);
      if (point.x < -220 || point.x > width + 220 || point.y < -45 || point.y > height + 45) continue;
      var title = width < 600 ? truncateText(cluster.title, 30) : cluster.title;
      var fontSize = clamp(11.5 + camera.zoom * 0.7, 12.5, 16);
      ctx.font = "700 " + fontSize + "px Avenir Next, Segoe UI, sans-serif";
      var titleWidth = Math.min(360, ctx.measureText(title).width);
      var boxWidth = titleWidth + 24;
      var boxHeight = fontSize + 23;
      var boxX = point.x - boxWidth * 0.5;
      var boxY = point.y - boxHeight * 0.5;
      if (boxX < 8 || boxX + boxWidth > width - 8 || boxY < 8 || boxY + boxHeight > height - 8) continue;
      var overlaps = occupied.some(function (box) {
        return !(boxX + boxWidth + 12 < box.x || boxX > box.x + box.width + 12 || boxY + boxHeight + 8 < box.y || boxY > box.y + box.height + 8);
      });
      if (overlaps) continue;
      var alpha = headingPhase * (selected >= 0 && data.nodes[selected].cluster !== index ? 0.28 : 1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = hexToRgba("#07110f", alpha * 0.9);
      ctx.strokeText(title, point.x, point.y - 5, 360);
      ctx.fillStyle = hexToRgba("#f2f5ef", alpha * 0.96);
      ctx.fillText(title, point.x, point.y - 5, 360);
      ctx.font = "800 8px Avenir Next, Segoe UI, sans-serif";
      ctx.fillStyle = hexToRgba(cluster.color, alpha * 0.92);
      ctx.fillText("KONSTELACE  ·  " + formatNumber(cluster.count) + " NODŮ", point.x, point.y + fontSize * 0.72);
      ctx.strokeStyle = hexToRgba(cluster.color, alpha * 0.58);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(point.x - Math.min(52, boxWidth * 0.22), point.y + fontSize + 5);
      ctx.lineTo(point.x + Math.min(52, boxWidth * 0.22), point.y + fontSize + 5);
      ctx.stroke();
      occupied.push({ x: boxX, y: boxY, width: boxWidth, height: boxHeight });
    }
    ctx.restore();
    return occupied;
  }

  function drawNodes(morph) {
    ctx.save();
    var selectedMode = selected >= 0;
    for (var hitIndex = 0; hitIndex < hitNodes.length; hitIndex += 1) {
      var index = hitNodes[hitIndex];
      var node = data.nodes[index];
      var visible = visibility[index];
      if (visible < 0.045) continue;
      var related = !selectedMode || index === selected || selectedNeighbors.has(index);
      var alpha = visible * (related ? 0.84 : 0.075);
      var radius = node.size * (0.48 + morph * 0.52) * (index === selected ? 1.7 : index === hovered ? 1.35 : 1);
      if (radius < 0.55) continue;
      var color = TYPE_COLORS[node.type] || "#a8bbb4";
      if (node.secondaryClusters && node.secondaryClusters.length && radius > 2.4) {
        ctx.strokeStyle = hexToRgba(data.clusters[node.secondaryClusters[0]].color, alpha * 0.7);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(sx[index], sy[index], radius + 2.2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = hexToRgba(color, alpha);
      if (index === selected || index === hovered) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 18;
      }
      ctx.beginPath();
      ctx.arc(sx[index], sy[index], radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (index === selected) {
        ctx.strokeStyle = "rgba(255,255,255,.9)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx[index], sy[index], radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawNodeLabels(morph, reservedBoxes) {
    var labelPhase = smoothstep(1.96, 2.42, camera.zoom);
    var selectedLabelPhase = smoothstep(1.9, 2.24, camera.zoom);
    if (labelPhase < 0.015 && selectedLabelPhase < 0.015 && hovered < 0) return;
    var salienceThreshold = mix(82, 42, smoothstep(1.65, 8.5, camera.zoom));
    var candidates = hitNodes
      .filter(function (index) {
        var node = data.nodes[index];
        var rank = clusterSalienceRank[index];
        var localLandmarkAlpha = rank < 10 ? smoothstep(1.82 + rank * 0.1, 2.38 + rank * 0.1, camera.zoom) : 0;
        return index === selected || index === hovered || (visibility[index] > 0.64 && (node.salience >= salienceThreshold || localLandmarkAlpha > 0.015));
      })
      .sort(function (left, right) {
        var leftBoost = left === selected ? 1000 : left === hovered ? 900 : data.nodes[left].salience;
        var rightBoost = right === selected ? 1000 : right === hovered ? 900 : data.nodes[right].salience;
        return rightBoost - leftBoost;
      });
    var occupied = (reservedBoxes || []).slice();
    var rendered = 0;
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.font = "600 11px Avenir Next, Segoe UI, sans-serif";
    for (var candidateIndex = 0; candidateIndex < candidates.length && rendered < labelLimit; candidateIndex += 1) {
      var index = candidates[candidateIndex];
      var node = data.nodes[index];
      var forced = index === selected || index === hovered;
      var rank = clusterSalienceRank[index];
      var localLandmarkAlpha = rank < 10 ? smoothstep(1.82 + rank * 0.1, 2.38 + rank * 0.1, camera.zoom) : 0;
      var rankedAlpha = node.salience >= salienceThreshold ? 1 : localLandmarkAlpha;
      var labelAlpha = index === selected ? selectedLabelPhase : forced ? Math.max(0.42, labelPhase) : labelPhase * rankedAlpha;
      if (labelAlpha < 0.015) continue;
      var title = forced ? node.title : truncateText(node.title, camera.zoom > 6.4 ? 44 : 31);
      var textWidth = Math.min(310, ctx.measureText(title).width);
      var boxWidth = textWidth + 18;
      var boxHeight = 24;
      var boxX = sx[index] - boxWidth * 0.5;
      var boxY = sy[index] - boxHeight * 0.5;
      if (!forced && (boxX < 8 || boxX + boxWidth > width - 8 || boxY < 8 || boxY + boxHeight > height - 8)) continue;
      var overlaps = !forced && occupied.some(function (box) {
        return !(boxX + boxWidth + 5 < box.x || boxX > box.x + box.width + 5 || boxY + boxHeight + 4 < box.y || boxY > box.y + box.height + 4);
      });
      if (overlaps) continue;
      var color = TYPE_COLORS[node.type] || "#a8bbb4";
      roundedRect(boxX, boxY, boxWidth, boxHeight, 12);
      ctx.fillStyle = hexToRgba("#091210", (forced ? 0.95 : 0.84 * visibility[index]) * labelAlpha);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(color, (forced ? 0.86 : 0.38 * visibility[index]) * labelAlpha);
      ctx.lineWidth = forced ? 1.35 : 0.8;
      ctx.stroke();
      ctx.fillStyle = hexToRgba("#f4f6f1", (forced ? 1 : 0.9 * visibility[index]) * labelAlpha);
      ctx.fillText(title, boxX + 9, sy[index] + 0.5, boxWidth - 18);
      occupied.push({ x: boxX, y: boxY, width: boxWidth, height: boxHeight });
      rendered += 1;
    }
    ctx.restore();
  }

  function drawEdgeLabel(x, y, label, alpha) {
    ctx.save();
    ctx.font = "700 9px Avenir Next, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var widthValue = ctx.measureText(label).width + 12;
    roundedRect(x - widthValue * 0.5, y - 9, widthValue, 18, 9);
    ctx.fillStyle = "rgba(6, 12, 12, " + (0.78 * alpha) + ")";
    ctx.fill();
    ctx.fillStyle = "rgba(222, 233, 228, " + alpha + ")";
    ctx.fillText(label, x, y + 0.5);
    ctx.restore();
  }

  function roundedRect(x, y, boxWidth, boxHeight, radius) {
    var r = Math.min(radius, boxWidth * 0.5, boxHeight * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + boxWidth, y, x + boxWidth, y + boxHeight, r);
    ctx.arcTo(x + boxWidth, y + boxHeight, x, y + boxHeight, r);
    ctx.arcTo(x, y + boxHeight, x, y, r);
    ctx.arcTo(x, y, x + boxWidth, y, r);
    ctx.closePath();
  }

  function render(now) {
    easeCamera();
    if (camera.zoom < nodeInteractionZoom && hovered >= 0) hovered = -1;
    var shouldCompactChrome = camera.zoom > 1.58;
    if (shell && shouldCompactChrome !== compactChrome) {
      compactChrome = shouldCompactChrome;
      shell.classList.toggle("is-exploring", compactChrome);
    }
    motionEnergy *= reducedMotion ? 0 : 0.965;
    if (motionEnergy < 0.002) motionEnergy = 0;
    drawBackdrop();
    var morph = projectNodes(now);
    drawClusterEdges(morph);
    drawActualEdges(morph);
    drawNodes(morph);
    drawClusters(morph);
    var headingBoxes = drawClusterHeadings();
    drawNodeLabels(morph, headingBoxes);
    updatePerformance(now);
    lastTime = now;
    requestAnimationFrame(render);
  }

  function updatePerformance(now) {
    frameCount += 1;
    if (frameCount < 90) return;
    var elapsed = now - fpsStarted;
    if (elapsed < 1400) return;
    var fps = frameCount * 1000 / elapsed;
    var previousQuality = quality;
    if (fps < 34) {
      quality = 0.62;
      labelLimit = 34;
      edgeStride = selected >= 0 ? 1 : 5;
    } else if (fps < 46) {
      quality = 0.82;
      labelLimit = 52;
      edgeStride = 3;
    } else {
      quality = 1;
      labelLimit = 70;
      edgeStride = 2;
    }
    if (performanceLabel) performanceLabel.textContent = Math.round(fps) + " fps · kvalita " + Math.round(quality * 100) + "%";
    if (Math.abs(previousQuality - quality) > 0.15) resize();
    frameCount = 0;
    fpsStarted = now;
  }

  function nearestAt(x, y) {
    // While cluster bubbles dominate visually, hidden member nodes must not
    // steal their pointer target. Search can still focus a node directly.
    if (camera.zoom < nodeInteractionZoom) return -1;
    var best = -1;
    var bestDistance = 18 * 18;
    for (var index = 0; index < hitNodes.length; index += 1) {
      var nodeIndex = hitNodes[index];
      if (visibility[nodeIndex] < 0.2) continue;
      var dx = sx[nodeIndex] - x;
      var dy = sy[nodeIndex] - y;
      var distance = dx * dx + dy * dy;
      var radius = Math.max(8, data.nodes[nodeIndex].size + 4);
      if (distance < Math.max(bestDistance, radius * radius) && distance < bestDistance) {
        best = nodeIndex;
        bestDistance = distance;
      }
    }
    return best;
  }

  function nearestClusterAt(x, y) {
    for (var index = hitClusters.length - 1; index >= 0; index -= 1) {
      var cluster = hitClusters[index];
      var dx = cluster.x - x;
      var dy = cluster.y - y;
      if (dx * dx + dy * dy <= cluster.radius * cluster.radius) return cluster.index;
    }
    return -1;
  }

  function selectNode(index, focus) {
    if (index < 0 || !data.nodes[index]) return;
    var selectedType = data.nodes[index].type;
    if (!activeTypes[selectedType]) {
      activeTypes[selectedType] = true;
      var selectedTypeButton = document.querySelector("[data-node-type='" + selectedType + "']");
      if (selectedTypeButton) selectedTypeButton.setAttribute("aria-pressed", "true");
    }
    selected = index;
    hovered = index;
    selectedNeighbors = new Set();
    selectedEdges = (edgesByNode[index] || []).slice();
    for (var edgeIndex = 0; edgeIndex < selectedEdges.length; edgeIndex += 1) {
      var edge = selectedEdges[edgeIndex];
      if (edge[0] === index) {
        selectedNeighbors.add(edge[1]);
      } else if (edge[1] === index) {
        selectedNeighbors.add(edge[0]);
      }
    }
    showNodePanel(index);
    if (focus) {
      targetCamera.x = data.nodes[index].x;
      targetCamera.y = data.nodes[index].y;
      targetCamera.zoom = Math.max(targetCamera.zoom, 4.15);
    }
    motionEnergy = reducedMotion ? 0 : 0.34;
  }

  function clearSelection() {
    selected = -1;
    hovered = -1;
    selectedNeighbors = new Set();
    selectedEdges = [];
    if (panel) panel.classList.remove("is-open");
  }

  function showNodePanel(index) {
    var node = data.nodes[index];
    var cluster = data.clusters[node.cluster];
    if (!panel || !node) return;
    panelKicker.textContent = TYPE_LABELS[node.type] + " · " + cluster.title;
    panelTitle.textContent = node.title;
    panelSummary.textContent = node.summary || "Tento node nemá samostatné shrnutí.";
    panelMeta.innerHTML = [
      STATUS_LABELS[node.status],
      Math.round(node.salience) + "% salience",
      selectedNeighbors.size + " sousedů",
      node.secondaryClusters.length ? "+" + node.secondaryClusters.length + " další konstelace" : null
    ].filter(Boolean).map(function (item) { return "<span>" + escapeHtml(item) + "</span>"; }).join("");
    panelLink.href = node.url || "#";
    panelLink.style.display = node.url ? "inline-flex" : "none";
    panel.classList.add("is-open");
  }

  function showIntro() {
    if (!panel) return;
    panelKicker.textContent = "Plynulá mapa";
    panelTitle.textContent = "Jak graf číst";
    panelSummary.textContent = "Oddálený pohled ukazuje významové konstelace. Při plynulém přiblížení se jejich obsah rozestupuje do jednotlivých myšlenek a skutečných vztahů. Barva nodu vyjadřuje jeho typ; tenký barevný prstenec značí další konstelaci. Hover ukáže propojení, klik uzamkne okolí a dvojklik otevře wiki.";
    panelMeta.innerHTML = "<span>hover · propojení</span><span>kolečko myši · zoom</span><span>tažení · pohyb</span><span>Esc · zavřít</span>";
    panelLink.style.display = "none";
    panel.classList.add("is-open");
  }

  function focusCluster(index) {
    var cluster = data.clusters[index];
    if (!cluster) return;
    targetCamera.x = cluster.x;
    targetCamera.y = cluster.y;
    var desiredZoom = Math.min(width, height) * 0.32 / Math.max(1, cluster.radius * baseScale);
    // Cluster focus also needs enough semantic morph for its members to
    // separate; geometric fit alone leaves a large cluster collapsed.
    targetCamera.zoom = clamp(desiredZoom, 3.55, 6.2);
    motionEnergy = reducedMotion ? 0 : 0.62;
  }

  function resetCamera() {
    targetCamera.x = (data.bounds.minX + data.bounds.maxX) * 0.5;
    targetCamera.y = (data.bounds.minY + data.bounds.maxY) * 0.5;
    targetCamera.zoom = 1;
    clearSelection();
    motionEnergy = reducedMotion ? 0 : 0.72;
  }

  function zoomBy(multiplier, x, y) {
    var anchorX = typeof x === "number" ? x : width * 0.5;
    var anchorY = typeof y === "number" ? y : height * 0.5;
    var before = worldPosition(anchorX, anchorY, true);
    targetCamera.zoom = clamp(targetCamera.zoom * multiplier, 0.52, 12);
    var after = worldPosition(anchorX, anchorY, true);
    targetCamera.x += before.x - after.x;
    targetCamera.y += before.y - after.y;
    motionEnergy = reducedMotion ? 0 : Math.max(motionEnergy, 0.36);
  }

  function buildFilters() {
    var nodeContainer = document.getElementById("node-filters");
    var relationContainer = document.getElementById("relation-filters");
    if (nodeContainer) {
      nodeContainer.innerHTML = TYPE_LABELS.map(function (label, index) {
        return '<button class="filter-button" type="button" data-node-type="' + index + '" aria-pressed="true"><span class="filter-dot" style="background:' + TYPE_COLORS[index] + '"></span>' + label + '</button>';
      }).join("");
      nodeContainer.addEventListener("click", function (event) {
        var button = event.target.closest("[data-node-type]");
        if (!button) return;
        var index = Number(button.getAttribute("data-node-type"));
        activeTypes[index] = !activeTypes[index];
        button.setAttribute("aria-pressed", String(activeTypes[index]));
        if (!activeTypes[index] && selected >= 0 && data.nodes[selected].type === index) clearSelection();
        motionEnergy = reducedMotion ? 0 : 0.25;
      });
    }
    if (relationContainer) {
      relationContainer.innerHTML = RELATION_LABELS.map(function (label, index) {
        return '<button class="filter-button" type="button" data-relation-type="' + index + '" aria-pressed="true"><span class="filter-dot" style="background:' + RELATION_COLORS[index] + '"></span>' + label + '</button>';
      }).join("");
      relationContainer.addEventListener("click", function (event) {
        var button = event.target.closest("[data-relation-type]");
        if (!button) return;
        var index = Number(button.getAttribute("data-relation-type"));
        activeRelations[index] = !activeRelations[index];
        button.setAttribute("aria-pressed", String(activeRelations[index]));
      });
    }
  }

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function setupSearch() {
    if (!searchInput || !searchResults) return;
    searchInput.addEventListener("input", function () {
      var query = normalize(searchInput.value.trim());
      if (query.length < 2) {
        searchResults.classList.remove("is-open");
        searchResults.innerHTML = "";
        return;
      }
      var terms = query.split(/\s+/).filter(Boolean);
      var matches = [];
      for (var index = 0; index < data.nodes.length; index += 1) {
        var node = data.nodes[index];
        var title = normalize(node.title);
        var score = title === query ? 1000 : title.indexOf(query) === 0 ? 500 : 0;
        for (var termIndex = 0; termIndex < terms.length; termIndex += 1) {
          if (title.indexOf(terms[termIndex]) !== -1) score += 40;
        }
        if (score > 0) matches.push({ index: index, score: score + node.salience * 0.1 });
      }
      matches.sort(function (left, right) { return right.score - left.score; });
      matches = matches.slice(0, 8);
      searchResults.innerHTML = matches.map(function (match) {
        var node = data.nodes[match.index];
        return '<button class="graph-search-result" type="button" data-result-index="' + match.index + '">' + escapeHtml(node.title) + '<span>' + TYPE_LABELS[node.type] + ' · ' + escapeHtml(data.clusters[node.cluster].title) + '</span></button>';
      }).join("");
      searchResults.classList.toggle("is-open", matches.length > 0);
    });
    searchResults.addEventListener("click", function (event) {
      var button = event.target.closest("[data-result-index]");
      if (!button) return;
      selectNode(Number(button.getAttribute("data-result-index")), true);
      searchResults.classList.remove("is-open");
      searchInput.blur();
    });
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function truncateText(value, length) {
    var text = String(value || "");
    return text.length > length ? text.slice(0, length - 1).trim() + "…" : text;
  }

  function splitClusterTitle(value, maxLength, maxLines) {
    var words = String(value || "").split(/\s+/);
    if (words.length < 2) return [value];
    var lines = [""];
    var limit = maxLines || 3;
    for (var index = 0; index < words.length; index += 1) {
      var current = lines[lines.length - 1];
      if (current && (current + " " + words[index]).length > maxLength && lines.length < limit) lines.push(words[index]);
      else lines[lines.length - 1] = current ? current + " " + words[index] : words[index];
    }
    return lines;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("cs-CZ", { notation: value > 999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
  }

  function hexToRgba(hex, alpha) {
    var normalized = hex.replace("#", "");
    if (normalized.length === 3) normalized = normalized.split("").map(function (char) { return char + char; }).join("");
    var number = parseInt(normalized, 16);
    return "rgba(" + ((number >> 16) & 255) + "," + ((number >> 8) & 255) + "," + (number & 255) + "," + clamp(alpha, 0, 1) + ")";
  }

  canvas.addEventListener("wheel", function (event) {
    event.preventDefault();
    var delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= height;
    // Chrome reports a trackpad pinch as a ctrl-modified wheel event with
    // small deltas. It needs materially higher gain than a physical wheel.
    var sensitivity = event.ctrlKey ? 0.0115 : 0.002;
    var exponent = clamp(-delta * sensitivity, -0.7, 0.7);
    zoomBy(Math.exp(exponent), event.clientX, event.clientY);
  }, { passive: false });

  canvas.addEventListener("pointerdown", function (event) {
    pointer.down = true;
    pointer.moved = false;
    pointer.startX = pointer.lastX = event.clientX;
    pointer.startY = pointer.lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
  });

  canvas.addEventListener("pointermove", function (event) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (pointer.down) {
      var dx = event.clientX - pointer.lastX;
      var dy = event.clientY - pointer.lastY;
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 4) pointer.moved = true;
      targetCamera.x -= dx / (baseScale * targetCamera.zoom);
      targetCamera.y -= dy / (baseScale * targetCamera.zoom);
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      motionEnergy = reducedMotion ? 0 : Math.max(motionEnergy, 0.16);
      return;
    }
    if (camera.zoom < nodeInteractionZoom) {
      hovered = -1;
      hoveredCluster = nearestClusterAt(event.clientX, event.clientY);
    } else {
      hovered = nearestAt(event.clientX, event.clientY);
      hoveredCluster = hovered < 0 ? nearestClusterAt(event.clientX, event.clientY) : -1;
    }
    canvas.style.cursor = hovered >= 0 || hoveredCluster >= 0 ? "pointer" : "grab";
  });

  canvas.addEventListener("pointerup", function (event) {
    pointer.down = false;
    canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = "grab";
    if (!pointer.moved) {
      if (camera.zoom < nodeInteractionZoom) {
        var overviewClusterIndex = nearestClusterAt(event.clientX, event.clientY);
        if (overviewClusterIndex >= 0) focusCluster(overviewClusterIndex);
        else clearSelection();
        return;
      }
      var nodeIndex = nearestAt(event.clientX, event.clientY);
      if (nodeIndex >= 0) selectNode(nodeIndex, false);
      else {
        var clusterIndex = nearestClusterAt(event.clientX, event.clientY);
        if (clusterIndex >= 0) focusCluster(clusterIndex);
        else clearSelection();
      }
    }
  });

  canvas.addEventListener("pointerleave", function () {
    if (!pointer.down) { hovered = -1; hoveredCluster = -1; }
  });

  canvas.addEventListener("dblclick", function (event) {
    var index = nearestAt(event.clientX, event.clientY);
    if (index >= 0 && data.nodes[index].url) window.location.href = data.nodes[index].url;
  });

  document.getElementById("zoom-in").addEventListener("click", function () { zoomBy(1.48); });
  document.getElementById("zoom-out").addEventListener("click", function () { zoomBy(1 / 1.48); });
  document.getElementById("zoom-reset").addEventListener("click", resetCamera);
  document.getElementById("node-panel-close").addEventListener("click", clearSelection);
  document.getElementById("graph-intro").addEventListener("click", showIntro);
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") clearSelection();
    if (event.key === "Enter" && selected >= 0 && data.nodes[selected].url && document.activeElement !== searchInput) {
      window.location.href = data.nodes[selected].url;
    }
    if ((event.key === "+" || event.key === "=") && document.activeElement !== searchInput) zoomBy(1.35);
    if (event.key === "-" && document.activeElement !== searchInput) zoomBy(1 / 1.35);
  });

  buildFilters();
  setupSearch();
  resize();
  resetCamera();
  canvas.style.cursor = "grab";
  requestAnimationFrame(render);
  requestAnimationFrame(function () {
    var loading = document.getElementById("graph-loading");
    if (loading) loading.classList.add("is-done");
  });
})();
`;

geotab.addin.zoneExport = function (elt, service) {
  'use strict';

  var MIN_CORNERS = 3;
  var ZONE_RESULTS_LIMIT = 1000;

  function $(id) { return elt.querySelector('#' + id); }

  var corners = [];          // [{lat, lng}, ...], polygon vertices in click order
  var vertexMarkers = [];    // Leaflet draggable markers, same order as corners
  var polygonLine = null;    // Leaflet polygon layer for the corner polygon
  var drawingActive = false;
  var leafletMap = null;

  var zoneTypesById = {};
  var matchedZones = [];
  var resultZoneLayers = []; // canvas path elements (on the real Geotab map) for matched-zone overlays

  // ---- Helpers --------------------------------------------------------

  function downloadBlob(filename, mimeType, content) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function timestampSuffix() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  function escapeXml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function computeBoundingBox(points) {
    var lats = points.map(function (p) { return p.lat; });
    var lngs = points.map(function (p) { return p.lng; });
    return {
      top: Math.max.apply(null, lats),
      bottom: Math.min.apply(null, lats),
      left: Math.min.apply(null, lngs),
      right: Math.max.apply(null, lngs)
    };
  }

  function pointInPolygon(lat, lng, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var yi = poly[i].lat, xi = poly[i].lng;
      var yj = poly[j].lat, xj = poly[j].lng;
      var intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function zoneCentroid(zone) {
    var pts = zone.points || [];
    if (!pts.length) return null;
    var sumLat = 0, sumLng = 0;
    pts.forEach(function (p) { sumLat += p.y; sumLng += p.x; });
    return { lat: sumLat / pts.length, lng: sumLng / pts.length };
  }

  // ---- Polygon editor (own embedded Leaflet map — draggable, click-to-add/remove) ----
  //
  // The Geotab map add-in API (service.map / service.events) only exposes screen-pixel
  // coordinates for clicks/moves over the real MyGeotab map, with no way to convert those
  // to lat/lng and no drag support on drawn elements. So the interactive polygon editor
  // runs on our own Leaflet map inside the add-in panel, where we have full mouse control.
  // The real Geotab map (via service.canvas) is only used afterwards, to show the zones
  // found inside the finished polygon — that only needs to draw shapes at known lat/lng.

  function initPolyMap() {
    leafletMap = L.map($('polyMap')).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(leafletMap);

    leafletMap.on('click', function (e) {
      if (!drawingActive) return;
      addVertex(e.latlng);
    });

    service.map.getBounds().then(function (bounds) {
      try {
        leafletMap.fitBounds([[bounds.sw.lat, bounds.sw.lng], [bounds.ne.lat, bounds.ne.lng]]);
      } catch (e) { /* keep default view */ }
    }).catch(function () { /* keep default view */ });

    setTimeout(function () { leafletMap.invalidateSize(); }, 200);
  }

  function setDrawingActive(active) {
    drawingActive = active;
    var btn = $('toggleDrawBtn');
    btn.textContent = active ? 'Desactivar selección de puntos' : 'Activar selección de puntos';
    btn.classList.toggle('active', active);
    $('polyMap').classList.toggle('drawing-active', active);
  }

  function redrawPolygonLine() {
    if (polygonLine) {
      leafletMap.removeLayer(polygonLine);
      polygonLine = null;
    }
    if (corners.length < 2) return;
    var latlngs = corners.map(function (c) { return [c.lat, c.lng]; });
    polygonLine = L.polygon(latlngs, {
      color: '#2f6fed',
      weight: 2,
      fillOpacity: corners.length >= MIN_CORNERS ? 0.12 : 0.03
    }).addTo(leafletMap);
  }

  function updatePolygonHint() {
    $('polygonHint').textContent = 'Puntos: ' + corners.length + ' (mínimo ' + MIN_CORNERS + ')';
    $('searchBtn').disabled = corners.length < MIN_CORNERS;
  }

  function addVertex(latlng) {
    var corner = { lat: latlng.lat, lng: latlng.lng };
    corners.push(corner);

    var marker = L.marker(latlng, { draggable: true }).addTo(leafletMap);

    marker.on('drag', function (e) {
      var idx = vertexMarkers.indexOf(marker);
      if (idx === -1) return;
      var ll = e.target.getLatLng();
      corners[idx] = { lat: ll.lat, lng: ll.lng };
      redrawPolygonLine();
    });

    marker.on('dragend', function () {
      clearResults();
      updatePolygonHint();
    });

    marker.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      var idx = vertexMarkers.indexOf(marker);
      if (idx === -1) return;
      corners.splice(idx, 1);
      vertexMarkers.splice(idx, 1);
      leafletMap.removeLayer(marker);
      redrawPolygonLine();
      updatePolygonHint();
      clearResults();
    });

    vertexMarkers.push(marker);
    redrawPolygonLine();
    updatePolygonHint();
    clearResults();
  }

  function undoLastVertex() {
    if (!corners.length) return;
    corners.pop();
    var marker = vertexMarkers.pop();
    if (marker) leafletMap.removeLayer(marker);
    redrawPolygonLine();
    updatePolygonHint();
    clearResults();
  }

  function resetPolygon() {
    corners = [];
    vertexMarkers.forEach(function (m) { leafletMap.removeLayer(m); });
    vertexMarkers = [];
    if (polygonLine) {
      leafletMap.removeLayer(polygonLine);
      polygonLine = null;
    }
    updatePolygonHint();
    clearResults();
  }

  // ---- Search -------------------------------------------------------------

  function clearResults() {
    resultZoneLayers.forEach(function (l) { l.remove(); });
    resultZoneLayers = [];
    matchedZones = [];
    $('resultsSection').style.display = 'none';
    $('exportSection').style.display = 'none';
    $('searchStatus').textContent = corners.length >= MIN_CORNERS
      ? 'Listo para buscar.'
      : 'Completá el polígono (mínimo ' + MIN_CORNERS + ' puntos) para habilitar la búsqueda.';
  }

  function runSearch() {
    if (corners.length < MIN_CORNERS) return;

    $('searchStatus').textContent = 'Buscando geocercas...';
    resultZoneLayers.forEach(function (l) { l.remove(); });
    resultZoneLayers = [];
    matchedZones = [];
    $('resultsSection').style.display = 'none';
    $('exportSection').style.display = 'none';

    var bbox = computeBoundingBox(corners);

    var zoneTypesPromise = Object.keys(zoneTypesById).length
      ? Promise.resolve()
      : service.api.call('Get', { typeName: 'ZoneType' }).then(function (types) {
          types.forEach(function (zt) { zoneTypesById[zt.id] = zt; });
        });

    var zonesPromise = service.api.call('Get', {
      typeName: 'Zone',
      search: {
        searchArea: { top: bbox.top, bottom: bbox.bottom, left: bbox.left, right: bbox.right }
      },
      resultsLimit: ZONE_RESULTS_LIMIT
    });

    Promise.all([zoneTypesPromise, zonesPromise]).then(function (results) {
      var zones = results[1];
      matchedZones = zones.filter(function (z) {
        var c = zoneCentroid(z);
        return c && pointInPolygon(c.lat, c.lng, corners);
      });
      renderResults(zones.length);
    }).catch(function (error) {
      $('searchStatus').textContent = 'Error al buscar geocercas: ' + (error && error.message || error);
    });
  }

  function typeIdsOf(zone) {
    return (zone.zoneTypes && zone.zoneTypes.length)
      ? zone.zoneTypes.map(function (zt) { return zt.id; })
      : ['__none__'];
  }

  function typeName(typeId) {
    if (typeId === '__none__') return 'Sin tipo';
    var full = zoneTypesById[typeId];
    return full ? full.name : typeId;
  }

  function renderResults(bboxCount) {
    var typeIdsPresent = {};
    matchedZones.forEach(function (zone) {
      typeIdsOf(zone).forEach(function (id) { typeIdsPresent[id] = true; });
    });

    var chipList = $('zoneTypeList');
    chipList.innerHTML = '';
    Object.keys(typeIdsPresent).sort(function (a, b) {
      return typeName(a).localeCompare(typeName(b));
    }).forEach(function (typeId) {
      var label = document.createElement('label');
      label.className = 'chip';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = true;
      input.addEventListener('change', function () {
        toggleZonesByType(typeId, input.checked);
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(typeName(typeId)));
      chipList.appendChild(label);
    });

    var list = $('zoneList');
    list.innerHTML = '';
    matchedZones.forEach(function (zone, index) {
      var row = document.createElement('div');
      row.className = 'zone-row';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.index = String(index);
      checkbox.dataset.typeIds = typeIdsOf(zone).join(',');
      row.appendChild(checkbox);

      var info = document.createElement('div');
      var nameEl = document.createElement('div');
      nameEl.className = 'zone-name';
      nameEl.textContent = zone.name || '(sin nombre)';
      info.appendChild(nameEl);

      var metaEl = document.createElement('div');
      metaEl.className = 'zone-meta';
      metaEl.textContent = typeIdsOf(zone).map(typeName).join(', ');
      info.appendChild(metaEl);

      row.appendChild(info);
      list.appendChild(row);

      var latlngs = (zone.points || []).map(function (p) { return { lat: p.y, lng: p.x }; });
      if (latlngs.length >= 3) {
        var segs = latlngs.map(function (pt, i) { return { type: i === 0 ? 'M' : 'L', points: [pt] }; });
        segs.push({ type: 'Z' });
        resultZoneLayers.push(
          service.canvas.path(segs, 20)
            .change({ fill: '#e0722d', stroke: '#e0722d', 'stroke-width': 1, 'fill-opacity': 0.15 })
        );
      }
    });

    var statusMsg = matchedZones.length + ' geocerca(s) dentro del polígono.';
    if (bboxCount >= ZONE_RESULTS_LIMIT) {
      statusMsg += ' Atención: se alcanzó el límite de ' + ZONE_RESULTS_LIMIT + ' resultados en el área rectangular de búsqueda; puede haber más geocercas de las mostradas. Achicá el polígono.';
    }
    $('searchStatus').textContent = statusMsg;
    $('zoneCountHint').textContent = 'Geocercas encontradas (' + matchedZones.length + ')';

    $('resultsSection').style.display = 'block';
    $('exportSection').style.display = matchedZones.length > 0 ? 'block' : 'none';
    $('kmlOutput').style.display = 'none';
    $('kmlOutput').value = '';
    $('exportStatus').textContent = '';
  }

  function toggleZonesByType(typeId, checked) {
    var checkboxes = $('zoneList').querySelectorAll('input[type=checkbox]');
    Array.prototype.forEach.call(checkboxes, function (cb) {
      if (cb.dataset.typeIds.split(',').indexOf(typeId) !== -1) cb.checked = checked;
    });
  }

  function getSelectedZones() {
    var checkboxes = $('zoneList').querySelectorAll('input[type=checkbox]');
    var selected = [];
    Array.prototype.forEach.call(checkboxes, function (cb) {
      if (cb.checked) selected.push(matchedZones[Number(cb.dataset.index)]);
    });
    return selected;
  }

  function setAllZoneCheckboxes(checked) {
    Array.prototype.forEach.call($('zoneList').querySelectorAll('input[type=checkbox]'), function (cb) { cb.checked = checked; });
    Array.prototype.forEach.call($('zoneTypeList').querySelectorAll('input[type=checkbox]'), function (cb) { cb.checked = checked; });
  }

  // ---- KML export -------------------------------------------------------

  function buildKml(zones) {
    var placemarks = zones.map(function (zone) {
      var typeNamesStr = typeIdsOf(zone).map(typeName).join(', ');
      var coords = (zone.points || []).map(function (p) { return p.x + ',' + p.y + ',0'; }).join(' ');
      var descLines = 'Tipos de zona: ' + typeNamesStr;
      if (zone.comment) descLines += '\nComentario: ' + zone.comment;

      return '    <Placemark>\n' +
        '      <name>' + escapeXml(zone.name || '(sin nombre)') + '</name>\n' +
        '      <description><![CDATA[' + descLines + ']]></description>\n' +
        '      <ExtendedData>\n' +
        '        <Data name="NOMBRE"><value>' + escapeXml(zone.name || '') + '</value></Data>\n' +
        '        <Data name="ZONETYPES"><value>' + escapeXml(typeNamesStr) + '</value></Data>\n' +
        '      </ExtendedData>\n' +
        '      <Polygon><outerBoundaryIs><LinearRing><coordinates>' + coords + '</coordinates></LinearRing></outerBoundaryIs></Polygon>\n' +
        '    </Placemark>';
    }).join('\n');

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
      '  <Document>\n' +
      '    <name>Geocercas exportadas</name>\n' +
      placemarks + '\n' +
      '  </Document>\n' +
      '</kml>\n';
  }

  function exportKml() {
    var selected = getSelectedZones();
    if (!selected.length) {
      $('exportStatus').textContent = 'Seleccioná al menos una geocerca para exportar.';
      return;
    }
    var kml = buildKml(selected);
    var kmlOutput = $('kmlOutput');
    kmlOutput.value = kml;
    kmlOutput.style.display = 'block';
    try { kmlOutput.focus(); kmlOutput.select(); } catch (e) { /* ignore */ }

    $('exportStatus').textContent = selected.length + ' geocerca(s) en el KML. Si la descarga automática no se dispara (el panel del mapa corre en un iframe con permisos limitados), copiá el texto de abajo y guardalo como archivo .kml.';

    try {
      downloadBlob('geocercas_' + timestampSuffix() + '.kml', 'application/vnd.google-earth.kml+xml', kml);
    } catch (e) {
      // download blocked by the iframe sandbox — the textarea above is the fallback
    }
  }

  function copyKml() {
    var kmlOutput = $('kmlOutput');
    if (!kmlOutput.value) {
      $('exportStatus').textContent = 'Generá el KML primero (Descargar KML).';
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(kmlOutput.value).then(function () {
        $('exportStatus').textContent = 'KML copiado al portapapeles.';
      }).catch(function () {
        kmlOutput.focus();
        kmlOutput.select();
        $('exportStatus').textContent = 'No se pudo copiar automáticamente. El texto ya está seleccionado, usá Ctrl+C.';
      });
    } else {
      kmlOutput.focus();
      kmlOutput.select();
      $('exportStatus').textContent = 'Seleccioná el texto (ya está resaltado) y copiá con Ctrl+C.';
    }
  }

  // ---- Wiring ------------------------------------------------------------

  $('toggleDrawBtn').addEventListener('click', function () { setDrawingActive(!drawingActive); });
  $('undoPointBtn').addEventListener('click', undoLastVertex);
  $('resetBtn').addEventListener('click', resetPolygon);
  $('searchBtn').addEventListener('click', runSearch);
  $('selectAllZonesBtn').addEventListener('click', function () { setAllZoneCheckboxes(true); });
  $('selectNoneZonesBtn').addEventListener('click', function () { setAllZoneCheckboxes(false); });
  $('exportKmlBtn').addEventListener('click', exportKml);
  $('copyKmlBtn').addEventListener('click', copyKml);

  initPolyMap();
  updatePolygonHint();
};

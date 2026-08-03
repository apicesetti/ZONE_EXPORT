geotab.addin.zoneExport = function () {
  'use strict';

  var MAX_CORNERS = 4;
  var ZONE_RESULTS_LIMIT = 1000;

  var currentApi = null;
  var map = null;
  var mapReady = false;

  var corners = [];        // [{lat, lng}, ...] up to MAX_CORNERS
  var cornerMarkers = [];  // Leaflet markers, same order as corners
  var polygonLayer = null;
  var resultsLayerGroup = null;
  var drawing = false;

  var zoneTypesById = {};
  var zoneTypesLoaded = false;
  var matchedZones = [];

  function $(id) { return document.getElementById(id); }

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

  // ---- Map / polygon drawing ----------------------------------------

  function initMap() {
    if (mapReady) return;
    map = L.map('zoneMap', { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    }).addTo(map);
    resultsLayerGroup = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
    mapReady = true;
  }

  function cornerIcon(index) {
    return L.divIcon({
      className: '',
      html: '<div class="corner-marker">' + (index + 1) + '</div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  function onMapClick(e) {
    if (!drawing || corners.length >= MAX_CORNERS) return;
    addCorner(e.latlng);
  }

  function addCorner(latlng) {
    var index = corners.length;
    corners.push({ lat: latlng.lat, lng: latlng.lng });

    var marker = L.marker(latlng, { draggable: true, icon: cornerIcon(index) }).addTo(map);
    marker.on('drag', function () {
      var ll = marker.getLatLng();
      corners[index] = { lat: ll.lat, lng: ll.lng };
      redrawPolygon();
      invalidateResults('El polígono cambió, volvé a buscar geocercas.');
    });
    cornerMarkers.push(marker);

    redrawPolygon();

    if (corners.length === MAX_CORNERS) {
      drawing = false;
      $('drawHint').textContent = 'Polígono completo. Podés arrastrar las esquinas para ajustarlo.';
      $('searchBtn').disabled = !zoneTypesLoaded;
    } else {
      $('drawHint').textContent = 'Marcá ' + (MAX_CORNERS - corners.length) + ' punto(s) más.';
    }
  }

  function redrawPolygon() {
    if (polygonLayer) {
      map.removeLayer(polygonLayer);
      polygonLayer = null;
    }
    if (corners.length < 2) return;
    var latlngs = corners.map(function (p) { return [p.lat, p.lng]; });
    var complete = corners.length === MAX_CORNERS;
    polygonLayer = L.polygon(latlngs, {
      color: '#2f6fed',
      weight: 2,
      dashArray: complete ? null : '6 4',
      fillOpacity: complete ? 0.12 : 0.05
    }).addTo(map);
  }

  function resetPolygon() {
    cornerMarkers.forEach(function (m) { map.removeLayer(m); });
    cornerMarkers = [];
    corners = [];
    if (polygonLayer) {
      map.removeLayer(polygonLayer);
      polygonLayer = null;
    }
    drawing = true;
    $('drawHint').textContent = 'Marcá 4 puntos en el mapa para definir el polígono.';
    $('searchBtn').disabled = true;
    resultsLayerGroup.clearLayers();
    matchedZones = [];
    $('zoneResultsWrap').style.display = 'none';
    $('searchStatus').textContent = 'Completá el polígono para habilitar la búsqueda.';
  }

  function invalidateResults(message) {
    matchedZones = [];
    resultsLayerGroup.clearLayers();
    $('zoneResultsWrap').style.display = 'none';
    $('searchStatus').textContent = message;
    $('searchBtn').disabled = !zoneTypesLoaded || corners.length !== MAX_CORNERS;
  }

  // ---- Geometry helpers -----------------------------------------------

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

  // ---- Zone type filter -------------------------------------------------

  function loadZoneTypes() {
    $('zoneTypesHint').textContent = 'Cargando tipos de zona...';
    currentApi.call('Get', { typeName: 'ZoneType' }, function (zoneTypes) {
      zoneTypesById = {};
      zoneTypes.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      var list = $('zoneTypeList');
      list.innerHTML = '';
      zoneTypes.forEach(function (zt) {
        zoneTypesById[zt.id] = zt;
        var label = document.createElement('label');
        label.className = 'chip';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = true;
        input.value = zt.id;
        label.appendChild(input);
        label.appendChild(document.createTextNode(zt.name || zt.id));
        list.appendChild(label);
      });
      zoneTypesLoaded = true;
      $('zoneTypesHint').textContent = zoneTypes.length + ' tipo(s) de zona disponibles.';
      $('searchBtn').disabled = corners.length !== MAX_CORNERS;
    }, function (error) {
      $('zoneTypesHint').textContent = 'Error al cargar tipos de zona: ' + (error && error.message || error);
    });
  }

  function getSelectedZoneTypeIds() {
    var checkboxes = $('zoneTypeList').querySelectorAll('input[type=checkbox]');
    var selected = [];
    Array.prototype.forEach.call(checkboxes, function (cb) { if (cb.checked) selected.push(cb.value); });
    return selected;
  }

  function setAllZoneTypeCheckboxes(checked) {
    var checkboxes = $('zoneTypeList').querySelectorAll('input[type=checkbox]');
    Array.prototype.forEach.call(checkboxes, function (cb) { cb.checked = checked; });
  }

  // ---- Search -------------------------------------------------------------

  function runSearch() {
    if (corners.length !== MAX_CORNERS) return;

    var selectedIds = getSelectedZoneTypeIds();
    var totalTypes = Object.keys(zoneTypesById).length;

    if (totalTypes > 0 && selectedIds.length === 0) {
      $('searchStatus').textContent = 'Seleccioná al menos un tipo de zona.';
      return;
    }

    var bbox = computeBoundingBox(corners);
    var search = {
      searchArea: { top: bbox.top, bottom: bbox.bottom, left: bbox.left, right: bbox.right }
    };
    if (selectedIds.length > 0 && selectedIds.length < totalTypes) {
      search.zoneTypes = selectedIds.map(function (id) { return { id: id }; });
    }

    $('searchStatus').textContent = 'Buscando geocercas...';
    $('zoneResultsWrap').style.display = 'none';

    currentApi.call('Get', {
      typeName: 'Zone',
      search: search,
      resultsLimit: ZONE_RESULTS_LIMIT
    }, function (zones) {
      var inPolygon = zones.filter(function (z) {
        var c = zoneCentroid(z);
        return c && pointInPolygon(c.lat, c.lng, corners);
      });
      matchedZones = inPolygon;
      renderResults(zones.length);
    }, function (error) {
      $('searchStatus').textContent = 'Error al buscar geocercas: ' + (error && error.message || error);
    });
  }

  function renderResults(bboxMatchCount) {
    resultsLayerGroup.clearLayers();

    var list = $('zoneList');
    list.innerHTML = '';

    matchedZones.forEach(function (zone, index) {
      var row = document.createElement('div');
      row.className = 'zone-row';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.index = String(index);
      row.appendChild(checkbox);

      var info = document.createElement('div');
      var nameEl = document.createElement('div');
      nameEl.className = 'zone-name';
      nameEl.textContent = zone.name || '(sin nombre)';
      info.appendChild(nameEl);

      var typeNames = (zone.zoneTypes || []).map(function (zt) {
        var full = zoneTypesById[zt.id];
        return full ? full.name : zt.id;
      }).join(', ');
      var metaEl = document.createElement('div');
      metaEl.className = 'zone-meta';
      metaEl.textContent = typeNames || 'Sin tipo';
      info.appendChild(metaEl);

      row.appendChild(info);
      list.appendChild(row);

      var latlngs = (zone.points || []).map(function (p) { return [p.y, p.x]; });
      if (latlngs.length >= 3) {
        L.polygon(latlngs, { color: '#e0722d', weight: 1, fillOpacity: 0.15 }).addTo(resultsLayerGroup);
      }
    });

    var statusMsg = matchedZones.length + ' geocerca(s) dentro del polígono.';
    if (bboxMatchCount >= ZONE_RESULTS_LIMIT) {
      statusMsg += ' Atención: se alcanzó el límite de ' + ZONE_RESULTS_LIMIT + ' resultados en el área rectangular de búsqueda; puede haber más geocercas de las mostradas. Achicá el polígono para asegurar cobertura completa.';
    }
    $('searchStatus').textContent = statusMsg;
    $('zoneCountHint').textContent = matchedZones.length + ' geocerca(s) encontradas';
    $('zoneResultsWrap').style.display = matchedZones.length > 0 ? 'block' : 'none';
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
    var checkboxes = $('zoneList').querySelectorAll('input[type=checkbox]');
    Array.prototype.forEach.call(checkboxes, function (cb) { cb.checked = checked; });
  }

  // ---- Export ---------------------------------------------------------------

  function exportJson() {
    var selected = getSelectedZones();
    if (!selected.length) {
      $('searchStatus').textContent = 'Seleccioná al menos una geocerca para exportar.';
      return;
    }
    var data = selected.map(function (zone) {
      return {
        id: zone.id,
        name: zone.name,
        comment: zone.comment,
        externalReference: zone.externalReference,
        zoneTypes: (zone.zoneTypes || []).map(function (zt) {
          var full = zoneTypesById[zt.id];
          return { id: zt.id, name: full ? full.name : null };
        }),
        points: zone.points
      };
    });
    downloadBlob('geocercas_poligono_' + timestampSuffix() + '.json', 'application/json', JSON.stringify(data, null, 2));
  }

  function exportGeoJson() {
    var selected = getSelectedZones();
    if (!selected.length) {
      $('searchStatus').textContent = 'Seleccioná al menos una geocerca para exportar.';
      return;
    }
    var featureCollection = {
      type: 'FeatureCollection',
      features: selected.map(function (zone) {
        var typeNames = (zone.zoneTypes || []).map(function (zt) {
          var full = zoneTypesById[zt.id];
          return full ? full.name : zt.id;
        });
        return {
          type: 'Feature',
          properties: {
            id: zone.id,
            name: zone.name,
            comment: zone.comment,
            zoneTypes: typeNames
          },
          geometry: {
            type: 'Polygon',
            coordinates: [(zone.points || []).map(function (p) { return [p.x, p.y]; })]
          }
        };
      })
    };
    downloadBlob('geocercas_poligono_' + timestampSuffix() + '.geojson', 'application/geo+json', JSON.stringify(featureCollection, null, 2));
  }

  // ---- Wiring ------------------------------------------------------------

  function wireEvents() {
    $('drawBtn').addEventListener('click', resetPolygon);
    $('searchBtn').addEventListener('click', runSearch);

    $('selectAllTypesBtn').addEventListener('click', function () { setAllZoneTypeCheckboxes(true); });
    $('selectNoneTypesBtn').addEventListener('click', function () { setAllZoneTypeCheckboxes(false); });

    $('selectAllZonesBtn').addEventListener('click', function () { setAllZoneCheckboxes(true); });
    $('selectNoneZonesBtn').addEventListener('click', function () { setAllZoneCheckboxes(false); });

    $('exportJsonBtn').addEventListener('click', exportJson);
    $('exportGeoJsonBtn').addEventListener('click', exportGeoJson);
  }

  var wired = false;

  return {
    initialize: function (api, state, callback) {
      currentApi = api;
      if (!wired) {
        wireEvents();
        wired = true;
      }
      callback();
    },

    focus: function (api, state) {
      currentApi = api;
      $('standaloneMsg').style.display = 'none';
      $('app').style.display = 'block';

      initMap();
      setTimeout(function () { map.invalidateSize(); }, 0);

      if (!zoneTypesLoaded) {
        loadZoneTypes();
      }
    },

    blur: function () {
      $('app').style.display = 'none';
      $('standaloneMsg').style.display = 'block';
    }
  };
};

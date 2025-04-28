let map = null;
let images = [];
let imagesByDate = {};
let currentDate = null;
let drawnItems = null;
let regions = [];
let points = [];
let metadata = { areas: [], points: {} };
let currentMapState = { zoom: null, center: null, index: 'Nenhum' };
let playIntervalId = null;

// Inicializar mapa Leaflet
function initMap() {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(map);

    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    const drawControl = new L.Control.Draw({
        draw: {
            polygon: true,
            polyline: false,
            rectangle: false,
            circle: false,
            marker: true,
            circlemarker: false
        },
        edit: {
            featureGroup: drawnItems
        }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (e) => {
        const layer = e.layer;
        drawnItems.addLayer(layer);
        if (e.layerType === 'polygon') {
            const regionId = `region-${regions.length + 1}`;
            layer.regionId = regionId;
            const popupContent = `
                <div>
                    <label>Nome da Região:</label><br>
                    <input type="text" id="region-name-${regionId}" value="${regionId}">
                    <button onclick="saveRegionName('${regionId}')">Salvar</button>
                </div>
            `;
            layer.bindPopup(popupContent).openPopup();
            regions.push({ id: regionId, layer, name: regionId, meanValues: {} });
            updateRegionsList();
            calculateRegionMeans(layer);
        } else if (e.layerType === 'marker') {
            const pointId = `point-${points.length + 1}`;
            layer.pointId = pointId;
            const pointType = document.getElementById('point-type').value;
            const popupContent = `
                <div>
                    <label>Nome do Ponto:</label><br>
                    <input type="text" id="point-name-${pointId}" value="${pointId}">
                    <button onclick="savePointName('${pointId}')">Salvar</button>
                </div>
            `;
            layer.bindPopup(popupContent).openPopup();
            points.push({
                id: pointId,
                layer,
                name: pointId,
                type: pointType,
                latlng: layer.getLatLng(),
                metadata: [],
                values: {}
            });
            metadata.points[pointId] = [];
            updatePointsList();
            calculatePointValues(layer);
        }
    });

    map.on(L.Draw.Event.EDITED, () => {
        regions.forEach(region => calculateRegionMeans(region.layer));
        points.forEach(point => {
            point.latlng = point.layer.getLatLng();
            calculatePointValues(point.layer);
        });
        updateRegionsList();
        updatePointsList();
        updateTemporalPlot();
    });

    map.on('moveend', () => {
        currentMapState.center = map.getCenter();
        currentMapState.zoom = map.getZoom();
        document.getElementById('debug-info').textContent = `Mapa ajustado: zoom ${currentMapState.zoom}, centro [${currentMapState.center.lat.toFixed(4)}, ${currentMapState.center.lng.toFixed(4)}].`;
    });

    document.getElementById('debug-info').textContent = 'Mapa inicializado com controle de desenho.';
}

// Adicionar imagens em lote
async function addImage() {
    const addBtn = document.getElementById('add-images-btn');
    addBtn.classList.add('loading');
    const files = document.getElementById('json-file').files;
    const udmFiles = document.getElementById('udm-file').files;

    if (!files.length) {
        alert('Por favor, selecione pelo menos um arquivo JSON ou GeoTIFF.');
        addBtn.classList.remove('loading');
        return;
    }

    const jsonFiles = Array.from(files).filter(f => f.name.endsWith('.json'));
    const tiffFiles = Array.from(files).filter(f => f.name.endsWith('.tif') || f.name.endsWith('.tiff'));

    if (!jsonFiles.length) {
        alert('Nenhum arquivo JSON selecionado.');
        addBtn.classList.remove('loading');
        return;
    }

    document.getElementById('debug-info').textContent = `Processando ${jsonFiles.length} imagem(ns)...`;
    let errors = [];
    let loadedCount = 0;

    for (let i = 0; i < jsonFiles.length; i++) {
        const jsonFile = jsonFiles[i];
        let tiffFile = null;
        let udmFile = null;

        try {
            const jsonName = jsonFile.name;
            let date = '';
            const dateMatch = jsonName.match(/(\d{4})(\d{2})(\d{2})\d{6}/);
            if (dateMatch) {
                date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
            } else {
                errors.push(`Data não encontrada no nome do arquivo: ${jsonName}`);
                continue;
            }

            const tiffName = jsonName.replace('.json', '.tif');
            tiffFile = tiffFiles.find(f => f.name === tiffName);
            if (!tiffFile) {
                errors.push(`GeoTIFF não encontrado para ${jsonName}. Certifique-se de que ${tiffName} está selecionado.`);
                continue;
            }

            if (udmFiles.length) {
                udmFile = Array.from(udmFiles).find(f => f.name.includes(jsonName.split('_L1C')[0]));
            }

            const jsonText = await jsonFile.text();
            const metadataJson = JSON.parse(jsonText);
            const layerConfig = metadataJson.productMetadata?.layerConfiguration;
            if (!layerConfig) {
                errors.push(`Seção layerConfiguration não encontrada em ${jsonName}`);
                continue;
            }

            const bandMapping = {};
            for (const [layer, bandName] of Object.entries(layerConfig)) {
                const bandNumber = parseInt(layer.replace('layer', ''));
                const normalizedName = bandName.toLowerCase();
                if (['blue', 'green', 'red', 'red edge', 'near infrared'].includes(normalizedName)) {
                    bandMapping[normalizedName.capitalize()] = bandNumber;
                }
            }

            if (!Object.keys(bandMapping).length) {
                errors.push(`Nenhuma banda válida encontrada em ${jsonName}`);
                continue;
            }

            const msiArrayBuffer = await tiffFile.arrayBuffer();
            const dataView = new DataView(msiArrayBuffer);
            const BOM = dataView.getUint16(0, false);
            if (BOM !== 0x4949 && BOM !== 0x4D4D) {
                errors.push(`GeoTIFF inválido: byte order inválido em ${tiffFile.name}`);
                continue;
            }

            const tiff = await GeoTIFF.fromArrayBuffer(msiArrayBuffer);
            const image = await tiff.getImage();
            const imageData = await image.readRasters({ interleave: false });
            if (!imageData || imageData.length === 0) {
                errors.push(`Nenhum dado válido lido do GeoTIFF ${tiffFile.name}`);
                continue;
            }
            const width = image.getWidth();
            const height = image.getHeight();
            const [minX, minY, maxX, maxY] = image.getBoundingBox();
            const tiffBounds = [[minY, minX], [maxY, maxX]];

            imageData.width = width;
            imageData.height = height;

            if (isNaN(minX) || isNaN(minY) || isNaN(maxX) || isNaN(maxY) ||
                minY < -90 || maxY > 90 || minX < -180 || maxX > 180) {
                errors.push(`Limites geográficos inválidos em ${tiffFile.name}. Verifique o CRS (WGS84/EPSG:4326).`);
                continue;
            }

            let maskData = null;
            if (udmFile) {
                const udmArrayBuffer = await udmFile.arrayBuffer();
                const udmTiff = await GeoTIFF.fromArrayBuffer(udmArrayBuffer);
                const udmImage = await udmTiff.getImage();
                maskData = (await udmImage.readRasters({ interleave: false }))[0];
                if (!maskData) {
                    errors.push(`Nenhum dado válido lido do UDM ${udmFile.name}`);
                }
            }

            const imageObj = {
                id: `image-${images.length + 1}-${date}`,
                date,
                json: metadataJson,
                tiff: tiffFile,
                imageData,
                originalImageData: imageData.map(band => new Float32Array(band)),
                maskData,
                bandMapping,
                tiffBounds,
                currentLayer: null,
                currentIndex: null,
                indexCache: {}
            };

            images.push(imageObj);
            if (!imagesByDate[date]) imagesByDate[date] = [];
            imagesByDate[date].push(imageObj);

            if (!currentDate) {
                currentDate = date;
            }

            if (!map) {
                initMap();
                map.fitBounds(tiffBounds, { maxZoom: 18 });
                currentMapState.zoom = map.getZoom();
                currentMapState.center = map.getCenter();
            }

            if (maskData) {
                applyMask(imageObj);
            }

            loadedCount++;
            document.getElementById('debug-info').textContent = `Processando ${i + 1}/${jsonFiles.length}: Imagem ${imageObj.id} adicionada para ${date}.`;
        } catch (e) {
            errors.push(`Erro ao processar ${jsonFile.name}: ${e.message}`);
        }
    }

    if (loadedCount > 0) {
        updateImagesList();
        updateTimelineSlider();
        updateIndex();
        document.getElementById('debug-info').textContent = `Carregadas ${loadedCount} de ${jsonFiles.length} imagens.`;
        updateTopBar();
    } else {
        document.getElementById('debug-info').textContent = 'Nenhuma imagem carregada.';
    }

    if (errors.length) {
        alert(`Erros encontrados:\n${errors.join('\n')}`);
    }
    addBtn.classList.remove('loading');
}

// Atualizar top-bar
function updateTopBar() {
    document.getElementById('current-date').textContent = currentDate || '-';
    document.getElementById('image-count').textContent = currentDate && imagesByDate[currentDate] ? imagesByDate[currentDate].length : 0;
    updateWeatherInfo();
}

// Atualizar informações de metadados na timeline
function updateWeatherInfo() {
    if (!currentDate) {
        document.getElementById('current-temperature').textContent = '-';
        document.getElementById('current-ph').textContent = '-';
        return;
    }
    const areaMeta = metadata.areas.find(m => m.date === currentDate);
    document.getElementById('current-temperature').textContent = areaMeta && areaMeta.temperature ? `${areaMeta.temperature}°C` : '-';
    document.getElementById('current-ph').textContent = areaMeta && areaMeta.ph ? areaMeta.ph : '-';
}

// Selecionar data
window.selectDate = function(date) {
    if (date !== currentDate) {
        currentDate = date;
        displayImagesForDate(date);
        updateTimelineSlider();
        updateRegionsList();
        updatePointsList();
        updateTemporalPlot();
        updateTopBar();
        document.getElementById('debug-info').textContent = `Data ${date} selecionada com ${imagesByDate[date]?.length || 0} imagens.`;
    }
};

// Exibir imagens para uma data
function displayImagesForDate(date) {
    images.forEach(img => {
        if (img.currentLayer) {
            map.removeLayer(img.currentLayer);
            img.currentLayer = null;
        }
    });

    const imageObjs = imagesByDate[date] || [];
    imageObjs.forEach(imageObj => {
        const indexName = currentMapState.index;
        if (indexName === 'Nenhum') {
            renderRGB(imageObj);
        } else {
            renderIndex(imageObj, indexName);
        }
    });

    if (imageObjs.length > 0) {
        if (currentMapState.zoom && currentMapState.center) {
            map.setView(currentMapState.center, currentMapState.zoom);
        } else {
            const bounds = combineBounds(imageObjs);
            map.fitBounds(bounds, { maxZoom: 18 });
            currentMapState.zoom = map.getZoom();
            currentMapState.center = map.getCenter();
        }
        document.getElementById('debug-info').textContent = `Exibidas ${imageObjs.length} imagens para ${date}.`;
    } else {
        document.getElementById('debug-info').textContent = `Nenhuma imagem para ${date}.`;
    }
}

// Combinar limites de múltiplas imagens
function combineBounds(imageObjs) {
    if (!imageObjs.length) return [[0, 0], [0, 0]];
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    imageObjs.forEach(img => {
        const [[swLat, swLng], [neLat, neLng]] = img.tiffBounds;
        minLat = Math.min(minLat, swLat);
        maxLat = Math.max(maxLat, neLat);
        minLng = Math.min(minLng, swLng);
        maxLng = Math.max(maxLng, neLng);
    });
    return [[minLat, minLng], [maxLat, maxLng]];
}

// Selecionar imagem por índice do slider
window.selectImageByIndex = function(index) {
    const uniqueDates = Object.keys(imagesByDate).sort();
    if (index >= 0 && index < uniqueDates.length) {
        selectDate(uniqueDates[index]);
    }
};

// Remover imagem
window.removeImage = function(imageId) {
    const imageObj = images.find(img => img.id === imageId);
    if (imageObj) {
        images = images.filter(img => img.id !== imageId);
        imagesByDate[imageObj.date] = imagesByDate[imageObj.date].filter(img => img.id !== imageId);
        if (imagesByDate[imageObj.date].length === 0) {
            delete imagesByDate[imageObj.date];
        }
        if (currentDate === imageObj.date && !imagesByDate[currentDate]) {
            const uniqueDates = Object.keys(imagesByDate).sort();
            currentDate = uniqueDates[0] || null;
        }
        if (imageObj.currentLayer) {
            map.removeLayer(imageObj.currentLayer);
            imageObj.currentLayer = null;
        }
        updateImagesList();
        updateTimelineSlider();
        updateRegionsList();
        updatePointsList();
        updateTemporalPlot();
        if (currentDate) {
            displayImagesForDate(currentDate);
        }
        updateTopBar();
        document.getElementById('debug-info').textContent = `Imagem ${imageId} removida.`;
    }
};

// Atualizar lista de imagens
function updateImagesList() {
    const listDiv = document.getElementById('images-list');
    if (!Object.keys(imagesByDate).length) {
        listDiv.innerHTML = 'Nenhuma imagem carregada.';
        return;
    }
    let html = '<ul>';
    Object.keys(imagesByDate).sort().forEach(date => {
        html += `<li><span class="date-link" onclick="selectDate('${date}')">${date}</span><ul>`;
        imagesByDate[date].forEach(img => {
            html += `<li class="image-item">${img.id}<button class="remove-btn" onclick="removeImage('${img.id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M10 11v6M14 11v6M6 6l1.5 12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1L18 6"/></svg></button></li>`;
        });
        html += '</ul></li>';
    });
    html += '</ul>';
    listDiv.innerHTML = html;
}

// Atualizar lista de pontos
function updatePointsList() {
    const listDiv = document.getElementById('points-list');
    if (points.length === 0) {
        listDiv.innerHTML = 'Nenhum ponto adicionado.';
        return;
    }
    let html = '<ul>';
    points.forEach(point => {
        const currentValue = currentDate && point.values[currentDate]
            ? point.values[currentDate][document.getElementById('index-select').value] || 'N/A'
            : 'N/A';
        html += `<li class="point-item">${point.name} (${point.type}): ${currentValue} <button onclick="removePoint('${point.id}')">Remover</button></li>`;
    });
    html += '</ul>';
    listDiv.innerHTML = html;
}

// Atualizar slider da linha do tempo
function updateTimelineSlider() {
    const slider = document.getElementById('timeline-slider');
    const uniqueDates = Object.keys(imagesByDate).sort();
    slider.max = uniqueDates.length - 1;
    slider.value = currentDate ? uniqueDates.indexOf(currentDate) : 0;
    if (uniqueDates.length <= 1) {
        slider.disabled = true;
        document.getElementById('play-button').disabled = true;
    } else {
        slider.disabled = false;
        document.getElementById('play-button').disabled = false;
    }
}

// Alternar reprodução automática
window.togglePlay = function() {
    const button = document.getElementById('play-button');
    if (playIntervalId) {
        clearInterval(playIntervalId);
        playIntervalId = null;
        button.textContent = 'Play';
        document.getElementById('debug-info').textContent = 'Reprodução pausada.';
    } else {
        const interval = parseFloat(document.getElementById('play-interval').value) * 1000;
        if (isNaN(interval) || interval < 500) {
            alert('Intervalo inválido. Use um valor >= 0.5 segundos.');
            return;
        }
        playImages(interval);
        button.textContent = 'Pausar';
        document.getElementById('debug-info').textContent = 'Reprodução iniciada.';
    }
};

// Reproduzir imagens automaticamente
function playImages(interval) {
    const uniqueDates = Object.keys(imagesByDate).sort();
    let currentIndex = uniqueDates.indexOf(currentDate);
    playIntervalId = setInterval(() => {
        currentIndex = (currentIndex + 1) % uniqueDates.length;
        selectDate(uniqueDates[currentIndex]);
    }, interval);
}

// Adicionar linha à tabela de metadados
window.addMetadataRow = function() {
    const metadataType = document.getElementById('metadata-type').value;
    const tbody = document.getElementById('metadata-table-body');
    const row = document.createElement('tr');
    if (metadataType === 'areas') {
        row.innerHTML = `
            <td><input type="date" onchange="updateMetadataTable()"></td>
            <td><input type="number" step="0.1" onchange="updateMetadataTable()"></td>
            <td><input type="number" step="0.1" onchange="updateMetadataTable()"></td>
            <td><input type="number" step="0.01" onchange="updateMetadataTable()"></td>
        `;
    } else {
        row.innerHTML = `
            <td><select onchange="updateMetadataTable()">
                ${points.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
            </select></td>
            <td><input type="date" onchange="updateMetadataTable()"></td>
            ${points.find(p => p.id === row.querySelector('select').value)?.type === 'monitoring' ? `
                <td><input type="number" step="0.1" onchange="updateMetadataTable()"></td>
                <td><input type="number" step="0.1" onchange="updateMetadataTable()"></td>
            ` : `
                <td><input type="number" step="0.01" onchange="updateMetadataTable()"></td>
                <td><input type="number" step="0.01" onchange="updateMetadataTable()"></td>
                <td><input type="number" step="0.01" onchange="updateMetadataTable()"></td>
            `}
        `;
    }
    tbody.appendChild(row);
    updateMetadataTable();
};

// Atualizar metadados da tabela
window.updateMetadataTable = function() {
    const metadataType = document.getElementById('metadata-type').value;
    const thead = document.getElementById('metadata-table-head');
    const tbody = document.getElementById('metadata-table-body');

    if (metadataType === 'areas') {
        thead.innerHTML = `
            <tr>
                <th>Data</th>
                <th>Temp (°C)</th>
                <th>pH</th>
                <th>NDVI</th>
            </tr>
        `;
        metadata.areas = [];
        for (const row of tbody.children) {
            const inputs = row.getElementsByTagName('input');
            const date = inputs[0].value;
            const temperature = inputs[1].value;
            const ph = inputs[2].value;
            const ndvi = inputs[3].value;
            if (date) {
                metadata.areas.push({
                    date,
                    temperature: temperature ? parseFloat(temperature) : null,
                    ph: ph ? parseFloat(ph) : null,
                    ndvi: ndvi ? parseFloat(ndvi) : null
                });
            }
        }
    } else {
        thead.innerHTML = `
            <tr>
                <th>Ponto</th>
                <th>Data</th>
                ${points.find(p => p.id === (tbody.children[0]?.querySelector('select')?.value || points[0]?.id))?.type === 'monitoring' ? `
                    <th>Temp (°C)</th>
                    <th>pH</th>
                ` : `
                    <th>Resist. Seca</th>
                    <th>Prot. Fungos</th>
                    <th>Cresc. Raízes</th>
                `}
            </tr>
        `;
        for (const point of points) {
            metadata.points[point.id] = [];
        }
        for (const row of tbody.children) {
            const select = row.getElementsByTagName('select')[0];
            const inputs = row.getElementsByTagName('input');
            const pointId = select.value;
            const date = inputs[0].value;
            if (points.find(p => p.id === pointId)?.type === 'monitoring') {
                const temperature = inputs[1].value;
                const ph = inputs[2].value;
                if (date) {
                    metadata.points[pointId].push({
                        date,
                        temperature: temperature ? parseFloat(temperature) : null,
                        ph: ph ? parseFloat(ph) : null
                    });
                }
            } else {
                const droughtResistance = inputs[1].value;
                const fungalProtection = inputs[2].value;
                const rootGrowth = inputs[3].value;
                if (date) {
                    metadata.points[pointId].push({
                        date,
                        droughtResistance: droughtResistance ? parseFloat(droughtResistance) : null,
                        fungalProtection: fungalProtection ? parseFloat(fungalProtection) : null,
                        rootGrowth: rootGrowth ? parseFloat(rootGrowth) : null
                    });
                }
            }
        }
    }

    updateTemporalPlot();
    updateWeatherInfo();
    document.getElementById('debug-info').textContent = `Metadados ${metadataType} atualizados.`;
};

// Aplicar máscara UDM
function applyMask(imageObj) {
    if (!imageObj.imageData || !imageObj.maskData) return;
    let validPixels = 0;
    imageObj.imageData = imageObj.originalImageData.map(band => new Float32Array(band));
    for (let i = 0; i < imageObj.imageData.length; i++) {
        const band = imageObj.imageData[i];
        for (let j = 0; j < band.length; j++) {
            if (imageObj.maskData[j] === 0) {
                validPixels++;
            } else {
                band[j] = NaN;
            }
        }
    }
    const validPercent = (validPixels / imageObj.maskData.length * 100).toFixed(2);
    console.log(`Pixels válidos após máscara (${imageObj.id}): ${validPixels} (${validPercent}%)`);
    document.getElementById('debug-info').textContent = `Máscara aplicada em ${imageObj.id}: ${validPercent}% pixels válidos.`;
    if (validPercent < 10) {
        alert(`A máscara UDM eliminou a maioria dos pixels em ${imageObj.id}. Considere desativá-la.`);
    }
}

// Salvar nome da região
window.saveRegionName = function(regionId) {
    const input = document.getElementById(`region-name-${regionId}`);
    const region = regions.find(r => r.id === regionId);
    if (region && input) {
        region.name = input.value || regionId;
        region.layer.closePopup();
        calculateRegionMeans(region.layer);
        updateRegionsList();
        updateTemporalPlot();
        document.getElementById('debug-info').textContent = `Nome da região ${regionId} atualizado para ${region.name}.`;
    }
};

// Salvar nome do ponto
window.savePointName = function(pointId) {
    const input = document.getElementById(`point-name-${pointId}`);
    const point = points.find(p => p.id === pointId);
    if (point && input) {
        point.name = input.value || pointId;
        point.layer.closePopup();
        calculatePointValues(point.layer);
        updatePointsList();
        updateTemporalPlot();
        document.getElementById('debug-info').textContent = `Nome do ponto ${pointId} atualizado para ${point.name}.`;
    }
};

// Remover região
window.removeRegion = function(regionId) {
    const region = regions.find(r => r.id === regionId);
    if (region) {
        drawnItems.removeLayer(region.layer);
        regions = regions.filter(r => r.id !== regionId);
        updateRegionsList();
        updateTemporalPlot();
        document.getElementById('debug-info').textContent = `Região ${regionId} removida.`;
    }
};

// Remover ponto
window.removePoint = function(pointId) {
    const point = points.find(p => p.id === pointId);
    if (point) {
        drawnItems.removeLayer(point.layer);
        points = points.filter(p => p.id !== pointId);
        delete metadata.points[pointId];
        updatePointsList();
        updateTemporalPlot();
        document.getElementById('debug-info').textContent = `Ponto ${pointId} removido.`;
    }
};

// Atualizar lista de regiões
function updateRegionsList() {
    const listDiv = document.getElementById('regions-list');
    if (regions.length === 0) {
        listDiv.innerHTML = 'Nenhuma região desenhada.';
        return;
    }
    let html = '<ul>';
    regions.forEach(region => {
        const currentMean = currentDate && region.meanValues[currentDate]
            ? region.meanValues[currentDate][document.getElementById('index-select').value] || 'N/A'
            : 'N/A';
        html += `<li class="region-item">${region.name}: ${currentMean} <button onclick="removeRegion('${region.id}')">Remover</button></li>`;
    });
    html += '</ul>';
    listDiv.innerHTML = html;
}

// Calcular valores médios para uma região em todas as datas
function calculateRegionMeans(layer) {
    if (!Object.keys(imagesByDate).length) return;
    const region = regions.find(r => r.id === layer.regionId);
    if (!region) return;

    region.meanValues = {};
    Object.keys(imagesByDate).forEach(date => {
        const imageObjs = imagesByDate[date];
        region.meanValues[date] = {};

        ['Nenhum', 'NDVI', 'SAVI', 'EVI', 'NDWI', 'NDCI', 'NDTI', 'FAI', 'SABI', 'ARI', 'PRI'].forEach(indexName => {
            let allValues = [];
            imageObjs.forEach(image => {
                const latlngs = layer.getLatLngs()[0];
                const width = image.imageData.width;
                const height = image.imageData.height;
                const data = indexName === 'Nenhum' ? image.imageData[0]
                    : calculateIndex(indexName, image);

                let values = [];
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const lng = image.tiffBounds[0][1] + (x / width) * (image.tiffBounds[1][1] - image.tiffBounds[0][1]);
                        const lat = image.tiffBounds[1][0] - (y / height) * (image.tiffBounds[1][0] - image.tiffBounds[0][0]);
                        if (isPointInPolygon({ lat, lng }, latlngs)) {
                            const idx = y * width + x;
                            const value = indexName === 'Nenhum' ? data[idx]
                                : data ? data[idx] : NaN;

                            if (indexName === 'Nenhum' && !isNaN(value)) {
                                values.push(value);
                            } else if (indexName !== 'Nenhum' && !isNaN(value)) {
                                values.push(value);
                            }
                        }
                    }
                }
                allValues.push(...values);
            });

            if (allValues.length > 0) {
                const mean = allValues.reduce((a, b) => a + b, 0) / allValues.length;
                region.meanValues[date][indexName] = indexName === 'Nenhum' ? `RGB: ${mean.toFixed(4)}` : mean.toFixed(4);
            } else {
                region.meanValues[date][indexName] = 'N/A';
            }
        });
    });

    updateRegionsList();
    updateTemporalPlot();
}

// Calcular valores para um ponto em todas as datas
function calculatePointValues(layer) {
    if (!Object.keys(imagesByDate).length) return;
    const point = points.find(p => p.id === layer.pointId);
    if (!point) return;

    point.values = {};
    Object.keys(imagesByDate).forEach(date => {
        const imageObjs = imagesByDate[date];
        point.values[date] = {};

        ['Nenhum', 'NDVI', 'SAVI', 'EVI', 'NDWI', 'NDCI', 'NDTI', 'FAI', 'SABI', 'ARI', 'PRI'].forEach(indexName => {
            let allValues = [];
            imageObjs.forEach(image => {
                const { lat, lng } = point.latlng;
                const width = image.imageData.width;
                const height = image.imageData.height;
                const x = Math.floor(((lng - image.tiffBounds[0][1]) / (image.tiffBounds[1][1] - image.tiffBounds[0][1])) * width);
                const y = Math.floor(((image.tiffBounds[1][0] - lat) / (image.tiffBounds[1][0] - image.tiffBounds[0][0])) * height);
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    const idx = y * width + x;
                    const data = indexName === 'Nenhum' ? image.imageData[0]
                        : calculateIndex(indexName, image);
                    const value = data ? data[idx] : NaN;
                    if (!isNaN(value)) {
                        allValues.push(value);
                    }
                }
            });

            if (allValues.length > 0) {
                const mean = allValues.reduce((a, b) => a + b, 0) / allValues.length;
                point.values[date][indexName] = indexName === 'Nenhum' ? `RGB: ${mean.toFixed(4)}` : mean.toFixed(4);
            } else {
                point.values[date][indexName] = 'N/A';
            }
        });
    });

    updatePointsList();
    updateTemporalPlot();
}

// Verificar se um ponto está dentro do polígono
function isPointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].lat, yi = polygon[i].lng;
        const xj = polygon[j].lat, yj = polygon[j].lng;
        const intersect = ((yi > point.lng) !== (yj > point.lng)) &&
            (point.lat < (xj - xi) * (point.lng - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Atualizar gráfico temporal
function updateTemporalPlot() {
    const indexName = document.getElementById('index-select').value;
    const showIndices = document.getElementById('toggle-indices').checked;
    const showPhysicochemical = document.getElementById('toggle-physicochemical').checked;
    const showMetagenomic = document.getElementById('toggle-metagenomic').checked;
    const traces = [];
    let yAxisCount = 1;

    if (showIndices) {
        regions.forEach(region => {
            const dates = [];
            const values = [];
            Object.keys(imagesByDate).sort().forEach(date => {
                const mean = region.meanValues[date]?.[indexName];
                if (mean !== 'N/A' && !mean.startsWith('RGB')) {
                    dates.push(date);
                    values.push(parseFloat(mean));
                }
            });
            if (dates.length > 0) {
                traces.push({
                    x: dates,
                    y: values,
                    mode: 'lines+markers',
                    name: `${region.name} (${indexName})`,
                    line: { shape: 'linear' },
                    yaxis: 'y' + (indexName === 'Nenhum' ? yAxisCount + 1 : yAxisCount)
                });
            }
        });

        points.forEach(point => {
            const dates = [];
            const values = [];
            Object.keys(imagesByDate).sort().forEach(date => {
                const value = point.values[date]?.[indexName];
                if (value !== 'N/A' && !value.startsWith('RGB')) {
                    dates.push(date);
                    values.push(parseFloat(value));
                }
            });
            if (dates.length > 0) {
                traces.push({
                    x: dates,
                    y: values,
                    mode: 'lines+markers',
                    name: `${point.name} (${indexName})`,
                    line: { shape: 'linear', dash: 'dot' },
                    yaxis: 'y' + (indexName === 'Nenhum' ? yAxisCount + 1 : yAxisCount)
                });
            }
        });
        yAxisCount++;
    }

    if (showPhysicochemical) {
        ['temperature', 'ph'].forEach(field => {
            const dates = [];
            const values = [];
            metadata.areas.sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(m => {
                if (m[field] !== null) {
                    dates.push(m.date);
                    values.push(m[field]);
                }
            });
            if (dates.length > 0) {
                traces.push({
                    x: dates,
                    y: values,
                    mode: 'lines+markers',
                    name: `Área: ${field.charAt(0).toUpperCase() + field.slice(1)}`,
                    line: { dash: 'dash' },
                    yaxis: 'y' + yAxisCount
                });
            }
        });

        points.filter(p => p.type === 'monitoring').forEach(point => {
            ['temperature', 'ph'].forEach(field => {
                const dates = [];
                const values = [];
                metadata.points[point.id].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(m => {
                    if (m[field] !== null) {
                        dates.push(m.date);
                        values.push(m[field]);
                    }
                });
                if (dates.length > 0) {
                    traces.push({
                        x: dates,
                        y: values,
                        mode: 'lines+markers',
                        name: `${point.name}: ${field.charAt(0).toUpperCase() + field.slice(1)}`,
                        line: { dash: 'dot' },
                        yaxis: 'y' + yAxisCount
                    });
                }
            });
        });
        yAxisCount++;
    }

    if (showMetagenomic) {
        points.filter(p => p.type === 'metagenomic').forEach(point => {
            ['droughtResistance', 'fungalProtection', 'rootGrowth'].forEach(field => {
                const dates = [];
                const values = [];
                metadata.points[point.id].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(m => {
                    if (m[field] !== null) {
                        dates.push(m.date);
                        values.push(m[field]);
                    }
                });
                if (dates.length > 0) {
                    traces.push({
                        x: dates,
                        y: values,
                        mode: 'lines+markers',
                        name: `${point.name}: ${field === 'droughtResistance' ? 'Resist. Seca' : field === 'fungalProtection' ? 'Prot. Fungos' : 'Cresc. Raízes'}`,
                        line: { dash: 'dashdot' },
                        yaxis: 'y' + yAxisCount
                    });
                }
            });
        });
        yAxisCount++;
    }

    const layout = {
        autosize: true,
        title: `Evolução Temporal: Índices, Físico-Químicos e Metagenômicos`,
        yaxis: { title: indexName !== 'Nenhum' ? `Índice ${indexName}` : 'RGB', domain: [0.66, 1] },
        yaxis2: indexName === 'Nenhum' ? { title: 'RGB', domain: [0.33, 0.65], overlaying: 'y' } : { title: 'Físico-Químicos', domain: [0.33, 0.65] },
        yaxis3: { title: 'Metagenômicos', domain: [0, 0.32] },
        margin: { t: 90, b: 30, l: 50, r: 50 }, // aumentei o 'b' para dar espaço pro título dos eixos
        height: 400,
        showlegend: true,
        legend: { x: 1, xanchor: 'right', y: 1 }
    };
    

    Plotly.newPlot('temporal-plot', traces, layout);
}

// Normalizar array para visualização
function normalize(array) {
    if (!array || array.length === 0) {
        console.warn('Array vazio ou inválido para normalização.');
        document.getElementById('debug-info').textContent = 'Array vazio para normalização.';
        return new Array(array.length).fill(0);
    }

    let min = Infinity, max = -Infinity;
    let hasValid = false;

    for (let i = 0; i < array.length; i++) {
        const v = array[i];
        if (!isNaN(v) && v !== null && isFinite(v)) {
            hasValid = true;
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }

    if (!hasValid || min === max) {
        console.warn('Nenhum valor válido encontrado ou todos os valores são iguais.');
        document.getElementById('debug-info').textContent = 'Nenhum valor válido para normalização.';
        return new Array(array.length).fill(0);
    }

    const normalized = new Array(array.length);
    for (let i = 0; i < array.length; i++) {
        const v = array[i];
        normalized[i] = isNaN(v) || v === null || !isFinite(v) ? 0 : (v - min) / (max - min);
    }
    normalized.width = array.width || Math.sqrt(array.length);
    normalized.height = array.height || array.length / normalized.width;
    return normalized;
}

// Criar imagem PNG para sobreposição
function createImageOverlay(data, width, height, isRGB = false) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);

    if (isRGB) {
        const [red, green, blue] = data;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                imgData.data[idx] = red[y][x] * 255;
                imgData.data[idx + 1] = green[y][x] * 255;
                imgData.data[idx + 2] = blue[y][x] * 255;
                imgData.data[idx + 3] = isNaN(red[y][x]) || isNaN(green[y][x]) || isNaN(blue[y][x]) ? 0 : 255;
            }
        }
    } else {
        const colormap = [
            [0, 'rgb(165,0,38)'],
            [0.5, 'rgb(255,255,191)'],
            [1, 'rgb(0,104,55)']
        ];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const value = data[y][x];
                let color = [0, 0, 0, 0];
                if (!isNaN(value)) {
                    if (value <= 0.5) {
                        const t = value / 0.5;
                        color = [
                            (1 - t) * 165 + t * 255,
                            t * 255,
                            (1 - t) * 38 + t * 191,
                            255
                        ];
                    } else {
                        const t = (value - 0.5) / 0.5;
                        color = [
                            (1 - t) * 255,
                            (1 - t) * 255 + t * 104,
                            (1 - t) * 191 + t * 55,
                            255
                        ];
                    }
                }
                imgData.data[idx] = color[0];
                imgData.data[idx + 1] = color[1];
                imgData.data[idx + 2] = color[2];
                imgData.data[idx + 3] = color[3];
            }
        }
    }

    ctx.putImageData(imgData, 0, 0);
    const imageUrl = canvas.toDataURL('image/png');
    document.getElementById('debug-info').textContent = 'Imagem PNG gerada para sobreposição.';
    return imageUrl;
}

// Renderizar RGB para uma imagem
function renderRGB(imageObj) {
    const bandMapping = imageObj.bandMapping;
    const redBand = bandMapping['Red'] - 1;
    const greenBand = bandMapping['Green'] - 1;
    const blueBand = bandMapping['Blue'] - 1;

    if (!['Red', 'Green', 'Blue'].every(b => b in bandMapping) ||
        redBand < 0 || redBand >= imageObj.imageData.length ||
        greenBand < 0 || greenBand >= imageObj.imageData.length ||
        blueBand < 0 || blueBand >= imageObj.imageData.length) {
        console.warn(`Bandas RGB não disponíveis para ${imageObj.id}.`);
        document.getElementById('debug-info').textContent = `Bandas RGB não disponíveis para ${imageObj.id}.`;
        return;
    }

    const height = imageObj.imageData.height;
    const width = imageObj.imageData.width;

    const red = normalize(imageObj.imageData[redBand]).reshape(height, width);
    const green = normalize(imageObj.imageData[greenBand]).reshape(height, width);
    const blue = normalize(imageObj.imageData[blueBand]).reshape(height, width);

    if (red.every(row => row.every(v => v === 0)) &&
        green.every(row => row.every(v => v === 0)) &&
        blue.every(row => row.every(v => v === 0))) {
        console.warn(`Nenhum dado válido nas bandas RGB para ${imageObj.id}.`);
        document.getElementById('debug-info').textContent = `Nenhum dado válido nas bandas RGB para ${imageObj.id}.`;
        return;
    }

    try {
        if (imageObj.currentLayer) {
            map.removeLayer(imageObj.currentLayer);
            imageObj.currentLayer = null;
        }
        const imageUrl = createImageOverlay([red, green, blue], width, height, true);
        imageObj.currentLayer = L.imageOverlay(imageUrl, imageObj.tiffBounds, { opacity: 1 }).addTo(map);
        imageObj.currentIndex = null;
        document.getElementById('debug-info').textContent = `Imagem RGB sobreposta para ${imageObj.id}.`;
    } catch (e) {
        console.error(`Erro ao renderizar RGB para ${imageObj.id}: ${e.message}`);
        document.getElementById('debug-info').textContent = `Erro ao renderizar RGB para ${imageObj.id}: ${e.message}`;
    }
}

// Renderizar índice para uma imagem
function renderIndex(imageObj, indexName) {
    const indexData = calculateIndex(indexName, imageObj);
    if (indexData) {
        imageObj.currentIndex = indexData;
        const height = imageObj.imageData.height;
        const width = imageObj.imageData.width;
        const indexArray = normalize(indexData).reshape(height, width);
        if (indexArray.every(row => row.every(v => v === 0))) {
            console.warn(`Nenhum dado válido no índice ${indexName} para ${imageObj.id}.`);
            document.getElementById('debug-info').textContent = `Nenhum dado válido no índice ${indexName} para ${imageObj.id}.`;
            return;
        }

        try {
            if (imageObj.currentLayer) {
                map.removeLayer(imageObj.currentLayer);
                imageObj.currentLayer = null;
            }
            const imageUrl = createImageOverlay(indexArray, width, height, false);
            imageObj.currentLayer = L.imageOverlay(imageUrl, imageObj.tiffBounds, { opacity: 1 }).addTo(map);
            document.getElementById('debug-info').textContent = `Índice ${indexName} sobreposto para ${imageObj.id}.`;
        } catch (e) {
            console.error(`Erro ao renderizar índice ${indexName} para ${imageObj.id}: ${e.message}`);
            document.getElementById('debug-info').textContent = `Erro ao renderizar índice para ${imageObj.id}: ${e.message}`;
        }
    }
}

// Atualizar índice espectral
async function updateIndex() {
    if (!currentDate || !imagesByDate[currentDate]) {
        alert('Nenhuma data selecionada ou imagens carregadas.');
        document.getElementById('debug-info').textContent = 'Nenhuma data selecionada.';
        return;
    }

    const indexName = document.getElementById('index-select').value;
    const descriptions = {
        'Nenhum': 'Sem índice espectral. Exibe visualização RGB conforme definido no JSON.',
        'NDVI': 'Índice de Vegetação por Diferença Normalizada. Mede a saúde vegetal. Útil para detectar estresse por pragas ou doenças.',
        'SAVI': 'Índice de Vegetação Ajustado ao Solo. Avalia vegetação em solos expostos, inferindo características do solo.',
        'EVI': 'Índice de Vegetação Aprimorado. Monitora biomassa, menos sensível à saturação.',
        'NDWI': 'Índice de Água por Diferença Normalizada. Avalia umidade na vegetação e solo, essencial para bactérias.',
        'NDCI': 'Índice de Clorofila por Diferença Normalizada. Detecta clorofila, útil para doenças bacterianas.',
        'NDTI': 'Índice de Cultivo por Diferença Normalizada. Avalia resíduos de culturas e manejo do solo.',
        'FAI': 'Índice de Algas Flutuantes. Detecta biomassa aquática em áreas irrigadas.',
        'SABI': 'Índice de Floração Algal na Superfície. Monitora matéria orgânica e atividade bacteriana em solos úmidos.',
        'ARI': 'Índice de Reflectância de Antocianina. Detecta estresse vegetal por pragas ou deficiências.',
        'PRI': 'Índice de Reflectância Fotoquímica (aproximado). Avalia eficiência fotossintética, sensível a pragas e bactérias.'
    };
    document.getElementById('index-description').textContent = descriptions[indexName] || '';
    currentMapState.index = indexName;

    displayImagesForDate(currentDate);
    regions.forEach(region => calculateRegionMeans(region.layer));
    points.forEach(point => calculatePointValues(point.layer));
    updateTemporalPlot();

    map.on('mousemove', (e) => {
        if (currentDate) {
            const { lat, lng } = e.latlng;
            let pixelValue = `Valor do Pixel (${indexName}): -`;
            imagesByDate[currentDate].forEach(imageObj => {
                const width = imageObj.imageData.width;
                const height = imageObj.imageData.height;
                const x = Math.floor(((lng - imageObj.tiffBounds[0][1]) / (imageObj.tiffBounds[1][1] - imageObj.tiffBounds[0][1])) * width);
                const y = Math.floor(((imageObj.tiffBounds[1][0] - lat) / (imageObj.tiffBounds[1][0] - imageObj.tiffBounds[0][0])) * height);
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    const idx = y * width + x;
                    if (indexName === 'Nenhum') {
                        const r = imageObj.imageData[imageObj.bandMapping['Red'] - 1][idx];
                        const g = imageObj.imageData[imageObj.bandMapping['Green'] - 1][idx];
                        const b = imageObj.imageData[imageObj.bandMapping['Blue'] - 1][idx];
                        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
                            pixelValue = `Valor do Pixel (${imageObj.id}, RGB): [${r.toFixed(2)}, ${g.toFixed(2)}, ${b.toFixed(2)}]`;
                        }
                    } else {
                        const value = imageObj.currentIndex ? imageObj.currentIndex[idx] : NaN;
                        if (!isNaN(value)) {
                            pixelValue = `Valor do Pixel (${imageObj.id}, ${indexName}): ${value.toFixed(4)}`;
                        }
                    }
                }
            });
            document.getElementById('pixel-value').textContent = pixelValue;
        }
    });
}

// Calcular índice espectral
function calculateIndex(indexName, image) {
    if (!image.imageData || !image.bandMapping) return null;

    if (image.indexCache[indexName]) {
        document.getElementById('debug-info').textContent = `Índice ${indexName} carregado do cache para ${image.id}.`;
        return image.indexCache[indexName];
    }

    const blueIdx = image.bandMapping['Blue'] - 1;
    const greenIdx = image.bandMapping['Green'] - 1;
    const redIdx = image.bandMapping['Red'] - 1;
    const redEdgeIdx = image.bandMapping['Red edge'] - 1;
    const nirIdx = image.bandMapping['Near infrared'] - 1;

    try {
        let result;
        if (indexName === 'NDVI' && 'Red' in image.bandMapping && 'Near infrared' in image.bandMapping) {
            const nir = image.imageData[nirIdx];
            const red = image.imageData[redIdx];
            result = new Array(nir.length);
            for (let i = 0; i < nir.length; i++) {
                const n = nir[i], r = red[i];
                result[i] = isNaN(n) || isNaN(r) ? NaN : (n - r) / (n + r);
            }
        } else if (indexName === 'SAVI' && 'Red' in image.bandMapping && 'Near infrared' in image.bandMapping) {
            const nir = image.imageData[nirIdx];
            const red = image.imageData[redIdx];
            const L = 0.5;
            result = new Array(nir.length);
            for (let i = 0; i < nir.length; i++) {
                const n = nir[i], r = red[i];
                result[i] = isNaN(n) || isNaN(r) ? NaN : ((n - r) / (n + r + L)) * (1 + L);
            }
        } else if (indexName === 'EVI' && ['Blue', 'Red', 'Near infrared'].every(k => k in image.bandMapping)) {
            const nir = image.imageData[nirIdx];
            const red = image.imageData[redIdx];
            const blue = image.imageData[blueIdx];
            result = new Array(nir.length);
            for (let i = 0; i < nir.length; i++) {
                const n = nir[i], r = red[i], b = blue[i];
                result[i] = isNaN(n) || isNaN(r) || isNaN(b) ? NaN : 2.5 * (n - r) / (n + 6 * r - 7.5 * b + 1);
            }
        } else if (indexName === 'NDWI' && 'Green' in image.bandMapping && 'Near infrared' in image.bandMapping) {
            const green = image.imageData[greenIdx];
            const nir = image.imageData[nirIdx];
            result = new Array(nir.length);
            for (let i = 0; i < nir.length; i++) {
                const g = green[i], n = nir[i];
                result[i] = isNaN(g) || isNaN(n) ? NaN : (g - n) / (g + n);
            }
        } else if (indexName === 'NDCI' && 'Red' in image.bandMapping && 'Red edge' in image.bandMapping) {
            const redEdge = image.imageData[redEdgeIdx];
            const red = image.imageData[redIdx];
            result = new Array(redEdge.length);
            for (let i = 0; i < redEdge.length; i++) {
                const re = redEdge[i], r = red[i];
                result[i] = isNaN(re) || isNaN(r) ? NaN : (re - r) / (re + r);
            }
        } else if (indexName === 'NDTI' && 'Red' in image.bandMapping && 'Green' in image.bandMapping) {
            const red = image.imageData[redIdx];
            const green = image.imageData[greenIdx];
            result = new Array(red.length);
            for (let i = 0; i < red.length; i++) {
                const r = red[i], g = green[i];
                result[i] = isNaN(r) || isNaN(g) ? NaN : (r - g) / (r + g);
            }
        } else if (indexName === 'FAI' && ['Red', 'Red edge', 'Near infrared'].every(k => k in image.bandMapping)) {
            const nir = image.imageData[nirIdx];
            const red = image.imageData[redIdx];
            const redEdge = image.imageData[redEdgeIdx];
            const lambdaRed = 665, lambdaRedEdge = 705, lambdaNIR = 865;
            result = new Array(nir.length);
            for (let i = 0; i < nir.length; i++) {
                const n = nir[i], r = red[i], re = redEdge[i];
                if (isNaN(n) || isNaN(r) || isNaN(re)) {
                    result[i] = NaN;
                } else {
                    const correction = r + ((n - r) / (lambdaNIR - lambdaRed)) * (lambdaNIR - lambdaRedEdge);
                    result[i] = n - correction;
                }
            }
        } else if (indexName === 'SABI' && ['Blue', 'Green', 'Red', 'Near infrared'].every(k => k in image.bandMapping)) {
            const nir = image.imageData[nirIdx];
            const red = image.imageData[redIdx];
            const green = image.imageData[greenIdx];
            const blue = image.imageData[blueIdx];
            result = new Array(nir.length);
            for (let i = 0; i < nir.length; i++) {
                const n = nir[i], r = red[i], g = green[i], b = blue[i];
                result[i] = isNaN(n) || isNaN(r) || isNaN(g) || isNaN(b) ? NaN : (n - r) / (g + b);
            }
          } else {
            console.warn(`Índice ${indexName} não suportado ou bandas ausentes para ${image.id}.`);
            document.getElementById('debug-info').textContent = `Índice ${indexName} não suportado para ${image.id}.`;
            return null;
        }

        if (result) {
            result.width = image.imageData.width;
            result.height = image.imageData.height;
            image.indexCache[indexName] = result;
            document.getElementById('debug-info').textContent = `Índice ${indexName} calculado para ${image.id}.`;
            return result;
        }
    } catch (e) {
        console.error(`Erro ao calcular índice ${indexName} para ${image.id}: ${e.message}`);
        document.getElementById('debug-info').textContent = `Erro ao calcular índice ${indexName}: ${e.message}`;
        return null;
    }
    return null;
}

// Função para alternar seção da sidebar
function toggleSection(panelId) {
    const panel = document.getElementById(panelId);
    const button = panel.previousElementSibling;
    const isExpanded = panel.classList.contains('expanded');
    document.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('expanded'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.add('collapsed'));
    if (!isExpanded) {
        panel.classList.add('expanded');
        button.classList.remove('collapsed');
    }
}

// Função utilitária para capitalizar strings
String.prototype.capitalize = function() {
    return this.charAt(0).toUpperCase() + this.slice(1);
};

// Redimensionar array para formato 2D
Array.prototype.reshape = function(rows, cols) {
    const result = [];
    let idx = 0;
    for (let i = 0; i < rows; i++) {
        const row = [];
        for (let j = 0; j < cols; j++) {
            row.push(this[idx] || 0);
            idx++;
        }
        result.push(row);
    }
    return result;
};

// Inicializar aplicação
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    document.getElementById('toggleSidebar').addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('collapsed');
        document.getElementById('debug-info').textContent = `Sidebar ${sidebar.classList.contains('collapsed') ? 'colapsada' : 'expandida'}.`;
    });

    // Adicionar listeners para controles do gráfico
    ['toggle-indices', 'toggle-physicochemical', 'toggle-metagenomic'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => {
            updateTemporalPlot();
            document.getElementById('debug-info').textContent = `Controle de gráfico ${id} alterado.`;
        });
    });

    // Inicializar metadados
    updateMetadataTable();
    document.getElementById('debug-info').textContent = 'Aplicação inicializada.';
});

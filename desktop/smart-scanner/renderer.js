pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js';
window.minimizeApp = () => window.api.minimizeApp();
window.maximizeApp = () => window.api.maximizeApp();
window.closeApp = () => window.api.closeApp();

let project = { pages: [], currentIndex: -1 };
let currentProjectId = null;
let currentFilePath = null;
let currentProjectName = 'مشروع جديد';
let processCanvas = document.createElement('canvas');
let processCtx = processCanvas.getContext('2d', { willReadFrequently: true });
const mainCanvas = document.getElementById('main-canvas');
const mainCtx = mainCanvas.getContext('2d');
const cropState = { active: false, points: [], isDragging: false, dragType: null, dragPoint: -1, startX: 0, startY: 0, startPoints: null, moved: false };
let dragStartIndex = -1;
const dbName = 'SmartScannerDB';
const dbVersion = 2;

function setStatus(msg) { 
    const el = document.getElementById('statusText'); 
    if (el) {
        el.innerHTML = '';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-circle-info mr-1';
        el.appendChild(icon);
        el.appendChild(document.createTextNode(' ' + String(msg || '')));
    }
}

function updateProjectNameUI() { 
    const el = document.getElementById('current-project-name');
    if (el) el.textContent = currentProjectName; 
}

function toggleDarkMode() { 
    document.body.classList.toggle('dark-mode'); 
    document.body.classList.toggle('light-mode'); 
    document.getElementById('theme-icon').className = document.body.classList.contains('dark-mode') ? 'fa-solid fa-moon' : 'fa-solid fa-sun'; 
}

function init() { 
    setupDragAndDrop(); 
    setupCropEvents(); 
    setupThumbnailsDragDrop(); 
    updateProjectNameUI(); 
    setStatus('● جاهز للاستخدام الفعلي'); 
}

function isSafeDataImageUrl(str) {
    return typeof str === 'string' && /^data:image\/(png|jpeg|jpg|bmp|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(str);
}

function normalizePage(page) {
    if (!page || typeof page !== 'object') throw new Error('بيانات الصفحة غير صالحة.');
    const orig = isSafeDataImageUrl(page.originalImage) ? page.originalImage : (isSafeDataImageUrl(page.workingImage) ? page.workingImage : null);
    if (!orig) throw new Error('صورة الصفحة غير صالحة أو تالفة.');
    
    const work = isSafeDataImageUrl(page.workingImage) ? page.workingImage : null;
    const w = Math.max(1, Math.min(20000, parseInt(page.width, 10) || 1));
    const h = Math.max(1, Math.min(20000, parseInt(page.height, 10) || 1));

    let crop = { x: 0, y: 0, w, h };
    if (page.crop && typeof page.crop === 'object') {
        crop = {
            x: Math.max(0, parseFloat(page.crop.x) || 0),
            y: Math.max(0, parseFloat(page.crop.y) || 0),
            w: Math.max(1, parseFloat(page.crop.w) || w),
            h: Math.max(1, parseFloat(page.crop.h) || h)
        };
    }

    const allowedFilters = ['none', 'bw', 'document', 'gray'];
    const filter = allowedFilters.includes(page.filter) ? page.filter : 'none';

    const normalized = {
        id: String(page.id || ('page_' + Date.now() + Math.random().toString(36).slice(2, 9))).slice(0, 64),
        originalImage: orig,
        workingImage: work,
        thumbnail: isSafeDataImageUrl(page.thumbnail) ? page.thumbnail : null,
        fileName: String(page.fileName || 'صفحة').slice(0, 120),
        width: w,
        height: h,
        crop,
        rotation: [0, 90, 180, 270].includes(Number(page.rotation)) ? Number(page.rotation) : 0,
        brightness: Math.max(-100, Math.min(100, parseInt(page.brightness, 10) || 0)),
        contrast: Math.max(-100, Math.min(100, parseInt(page.contrast, 10) || 0)),
        sharpness: Math.max(0, Math.min(100, parseInt(page.sharpness, 10) || 0)),
        saturation: Math.max(-100, Math.min(100, parseInt(page.saturation, 10) || 0)),
        filter,
        cleanBackground: !!page.cleanBackground
    };

    if (Number.isFinite(Number(page.customW_cm))) {
        normalized.customW_cm = Math.max(2.0, Math.min(25.0, Number(page.customW_cm)));
    }
    if (Number.isFinite(Number(page.customH_cm))) {
        normalized.customH_cm = Math.max(2.0, Math.min(29.0, Number(page.customH_cm)));
    }

    return normalized;
}

function generateThumbnailDataUrl(imgElement) {
    try {
        const maxDim = 140;
        const scale = Math.min(1, maxDim / Math.max(imgElement.width || 1, imgElement.height || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round((imgElement.width || 1) * scale));
        c.height = Math.max(1, Math.round((imgElement.height || 1) * scale));
        c.getContext('2d').drawImage(imgElement, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.75);
    } catch {
        return null;
    }
}

async function importFiles(event) { 
    const files = event.target.files; 
    if (!files || !files.length) return; 
    await handleFilesSelect(files); 
    event.target.value = ''; 
}

async function handleFilesSelect(files) {
    setStatus('جاري استيراد الملفات...');
    let imported = 0;
    for (const file of files) {
        if (file.type === 'application/pdf') { 
            await processPDF(file); 
            imported++; 
        }
        else if (file.type.startsWith('image/')) { 
            await processImageFile(file); 
            imported++; 
        }
        else {
            alert(`الملف ${file.name} غير مدعوم.`);
        }
    }
    renderThumbnails();
    if (project.currentIndex === -1 && project.pages.length) selectPage(0);
    setStatus(`تم استيراد ${imported} ملف بنجاح.`);
}

function processImageFile(file) { 
    return new Promise(resolve => { 
        const reader = new FileReader(); 
        reader.onload = e => createPageFromDataURL(e.target.result, file.name).then(resolve); 
        reader.onerror = () => resolve(); 
        reader.readAsDataURL(file); 
    }); 
}

async function processPDF(file) {
    setStatus(`جاري قراءة PDF: ${file.name}...`);
    const arrayBuffer = await file.arrayBuffer(); 
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i); 
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas'); 
        canvas.width = viewport.width; 
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        await createPageFromDataURL(canvas.toDataURL('image/jpeg', 0.95), `${file.name} - صفحة ${i}`);
    }
}

function createPageFromDataURL(dataURL, name) { 
    return new Promise(resolve => { 
        const img = new Image(); 
        img.onload = () => { 
            try {
                const thumb = generateThumbnailDataUrl(img);
                project.pages.push(normalizePage({
                    id: 'page_' + Date.now() + Math.random().toString(36).slice(2, 11),
                    originalImage: dataURL,
                    workingImage: null,
                    thumbnail: thumb,
                    fileName: name,
                    width: img.width,
                    height: img.height,
                    crop: { x: 0, y: 0, w: img.width, h: img.height },
                    rotation: 0,
                    brightness: 0,
                    contrast: 0,
                    sharpness: 0,
                    saturation: 0,
                    filter: 'none',
                    cleanBackground: false
                }));
            } catch (e) {
                console.error(e);
            }
            resolve(); 
        }; 
        img.onerror = () => resolve(); 
        img.src = dataURL; 
    }); 
}

function setupDragAndDrop() {
    const dz = document.getElementById('drop-zone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('bg-gray-800/80'); });
    dz.addEventListener('dragleave', e => { e.preventDefault(); dz.classList.remove('bg-gray-800/80'); });
    dz.addEventListener('drop', e => { 
        e.preventDefault(); 
        dz.classList.remove('bg-gray-800/80'); 
        if (e.dataTransfer.files?.length) handleFilesSelect(e.dataTransfer.files); 
    });
}

function renderThumbnails() {
    const container = document.getElementById('thumbnails-container'); 
    container.innerHTML = '';
    document.getElementById('pages-count-title').innerText = `الصفحات • ${project.pages.length}`;
    
    if (project.pages.length === 0) { 
        document.getElementById('empty-state').style.display = 'flex'; 
        document.getElementById('main-canvas').style.display = 'none'; 
        document.getElementById('canvas-toolbar').style.display = 'none'; 
        document.getElementById('page-controls').style.display = 'none'; 
        document.getElementById('preview-info').innerText = 'لا توجد صفحات'; 
        return; 
    }
    
    document.getElementById('page-controls').style.display = 'grid';
    
    project.pages.forEach((page, index) => {
        const div = document.createElement('div'); 
        const selected = index === project.currentIndex;
        div.className = `p-1 rounded cursor-pointer transition flex items-center gap-2 border-2 ${selected ? 'border-brand-primary bg-brand-primary/10' : 'border-transparent hover:bg-gray-800'} thumbnail-item`; 
        div.draggable = true; 
        div.dataset.index = index;
        
        const numDiv = document.createElement('div');
        numDiv.className = 'text-xs text-gray-500 font-bold w-4 text-center';
        numDiv.textContent = String(index + 1).padStart(2, '0');

        const thumb = document.createElement('img'); 
        thumb.className = 'w-12 h-16 object-contain bg-black/50 border border-gray-700'; 
        thumb.src = page.thumbnail || page.workingImage || page.originalImage;
        
        const infoWrap = document.createElement('div');
        infoWrap.className = 'flex-1 overflow-hidden';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'text-xs text-white truncate';
        nameDiv.title = String(page.fileName || '');
        nameDiv.textContent = String(page.fileName || '');

        const dimDiv = document.createElement('div');
        dimDiv.className = 'text-[10px] text-gray-500';
        dimDiv.textContent = `${Number(page.width) || 0}x${Number(page.height) || 0} px`;

        infoWrap.appendChild(nameDiv);
        infoWrap.appendChild(dimDiv);

        div.appendChild(numDiv);
        div.appendChild(thumb);
        div.appendChild(infoWrap);

        div.onclick = () => selectPage(index); 
        container.appendChild(div);
    });
}

function setupThumbnailsDragDrop() {
    const c = document.getElementById('thumbnails-container');
    c.addEventListener('dragstart', e => {
        const item = e.target.closest('.thumbnail-item');
        if (!item) return;
        dragStartIndex = parseInt(item.dataset.index, 10);
        item.classList.add('sortable-ghost');
        e.dataTransfer.effectAllowed = 'move';
    });
    c.addEventListener('dragover', e => { 
        e.preventDefault(); 
        e.dataTransfer.dropEffect = 'move'; 
    });
    c.addEventListener('drop', e => {
        e.preventDefault();
        const item = e.target.closest('.thumbnail-item');
        if (!item || dragStartIndex === -1) return;
        const end = parseInt(item.dataset.index, 10);
        if (dragStartIndex !== end) {
            const moved = project.pages.splice(dragStartIndex, 1)[0];
            project.pages.splice(end, 0, moved);
            if (project.currentIndex === dragStartIndex) {
                project.currentIndex = end;
            } else if (project.currentIndex > dragStartIndex && project.currentIndex <= end) {
                project.currentIndex--;
            } else if (project.currentIndex < dragStartIndex && project.currentIndex >= end) {
                project.currentIndex++;
            }
            renderThumbnails();
            renderMainCanvas();
        }
    });
    c.addEventListener('dragend', e => {
        const item = e.target.closest('.thumbnail-item');
        if (item) item.classList.remove('sortable-ghost');
        dragStartIndex = -1;
    });
}

function selectPage(index) {
    if (index < 0 || index >= project.pages.length) {
        project.currentIndex = -1;
        renderThumbnails();
        return;
    }
    project.currentIndex = index; 
    cropState.active = false; 
    cropState.isDragging = false;
    document.getElementById('crop-overlay').style.display = 'none'; 
    document.getElementById('btn-confirm-crop').style.display = 'none';
    const manualBtn = document.getElementById('btn-manual-crop');
    if (manualBtn) manualBtn.classList.remove('bg-brand-primary', 'text-white');
    renderThumbnails(); 
    updateLeftPanelUI(); 
    renderMainCanvas();
    document.getElementById('empty-state').style.display = 'none'; 
    document.getElementById('main-canvas').style.display = 'block'; 
    document.getElementById('canvas-toolbar').style.display = 'flex';
}

function updateLeftPanelUI() {
    const page = project.pages[project.currentIndex]; 
    if (!page) return;
    
    document.getElementById('rng-brightness').value = page.brightness;
    document.getElementById('val-brightness').innerText = page.brightness;
    document.getElementById('rng-contrast').value = page.contrast;
    document.getElementById('val-contrast').innerText = page.contrast;
    document.getElementById('rng-sharpness').value = page.sharpness;
    document.getElementById('val-sharpness').innerText = page.sharpness;
    document.getElementById('rng-saturation').value = page.saturation;
    document.getElementById('val-saturation').innerText = page.saturation;
    document.getElementById('chk-cleanbg').checked = page.cleanBackground;
    
    ['none', 'bw', 'document', 'gray'].forEach(f => {
        const btn = document.getElementById('flt-' + f);
        if (!btn) return;
        if (page.filter === f) {
            btn.classList.add('bg-brand-primary', 'text-white');
            btn.classList.remove('bg-gray-800', 'hover:bg-gray-700');
        } else {
            btn.classList.remove('bg-brand-primary', 'text-white');
            btn.classList.add('bg-gray-800', 'hover:bg-gray-700');
        }
    });
}

function updateAdjustment(prop, value) {
    if (project.currentIndex === -1) return;
    const p = project.pages[project.currentIndex];
    p[prop] = prop === 'cleanBackground' ? value : parseInt(value, 10);
    const v = document.getElementById(`val-${prop}`);
    if (v) v.innerText = value;
    renderMainCanvas();
}

function applyFilter(name) {
    if (project.currentIndex === -1) return;
    project.pages[project.currentIndex].filter = name;
    updateLeftPanelUI();
    renderMainCanvas();
}

function rotatePage() {
    if (project.currentIndex === -1) return;
    const p = project.pages[project.currentIndex];
    p.rotation = (p.rotation + 90) % 360;
    renderMainCanvas();
    if (cropState.active) clampCropPoints();
    setStatus(`تم تدوير الصفحة ${p.rotation}°`);
}

function resetCurrentPage() {
    if (project.currentIndex === -1) return;
    const p = project.pages[project.currentIndex];
    p.workingImage = null; 
    p.crop = { x: 0, y: 0, w: p.width, h: p.height }; 
    p.rotation = 0;
    p.brightness = 0;
    p.contrast = 0;
    p.sharpness = 0;
    p.saturation = 0;
    p.filter = 'none';
    p.cleanBackground = false;
    updateLeftPanelUI();
    renderMainCanvas();
    renderThumbnails();
    setStatus('تم إعادة ضبط الصفحة وإرجاع الصورة الأصلية.');
}

function duplicateCurrentPage() {
    if (project.currentIndex === -1) return;
    const d = JSON.parse(JSON.stringify(project.pages[project.currentIndex]));
    d.id = 'page_' + Date.now() + Math.random().toString(36).slice(2, 7);
    project.pages.splice(project.currentIndex + 1, 0, d);
    selectPage(project.currentIndex + 1);
    setStatus('تم تكرار الصفحة بنجاح.');
}

function deleteCurrentPage() {
    if (project.currentIndex === -1) return;
    if (!confirm('هل أنت متأكد من حذف هذه الصفحة؟')) return;
    project.pages.splice(project.currentIndex, 1);
    if (project.currentIndex >= project.pages.length) {
        project.currentIndex = Math.max(-1, project.pages.length - 1);
    }
    selectPage(project.currentIndex);
    setStatus('تم حذف الصفحة.');
}

function clearAllPages() {
    if (!project.pages.length) return;
    if (confirm('هل أنت متأكد من حذف جميع الصفحات؟')) {
        project.pages = [];
        selectPage(-1);
        setStatus('تم مسح جميع الصفحات.');
    }
}

async function loadScanners() {
    const select = document.getElementById('scanner-select');
    if (!select) return;
    
    select.innerHTML = '<option value="" class="bg-gray-800">جاري البحث...</option>';
    setStatus('جاري البحث عن أجهزة السكانر...');
    
    try {
        const scanners = await window.api.getScanners();
        select.innerHTML = '<option value="" class="bg-gray-800">نافذة الويندوز الافتراضية</option>';
        if (scanners && scanners.length > 0) {
            scanners.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.className = 'bg-gray-800 text-right';
                opt.textContent = s.name;
                select.appendChild(opt);
            });
            setStatus(`تم العثور على ${scanners.length} أجهزة سكانر.`);
        } else {
            setStatus('لم يتم العثور على أجهزة. تأكد من ربط السكانر.');
        }
    } catch (e) {
        select.innerHTML = '<option value="" class="bg-gray-800">نافذة الويندوز الافتراضية</option>';
        setStatus('حدث خطأ أثناء جلب الأجهزة.');
    }
}

async function simulateScanner() {
    const select = document.getElementById('scanner-select');
    const deviceId = select ? select.value : null;
    const mode = document.getElementById('scan-mode')?.value || 'duplex';
    const dpi = parseInt(document.getElementById('scan-dpi')?.value, 10) || 300;

    setStatus(deviceId ? `جاري السحب (${dpi} DPI)... يرجى الانتظار.` : 'جاري الاتصال بالسكانر... يرجى اختيار الطابعة من النافذة المنبثقة.');
    
    try {
        const results = await window.api.scanDocument({ deviceId: deviceId || null, dpi, duplex: mode === 'duplex' });
        
        if (results && Array.isArray(results) && results.length > 0) {
            setStatus(`تم السحب بنجاح. جاري إدراج ${results.length} هوية/صورة...`);
            
            const timeNow = new Date().toLocaleTimeString('ar-IQ').replace(/:/g, '-');
            
            for (let i = 0; i < results.length; i++) {
                const item = results[i];
                const fileName = `سحب ضوئي - ${timeNow} - جزء ${i + 1}`; 
                await createPageFromDataURL(item.dataUrl, fileName);
            }
            
            renderThumbnails();
            selectPage(project.pages.length - 1);
            setStatus('تم إضافة الصور من السكانر وقصها بنجاح.');
        } else {
            setStatus('لم يتم العثور على أي صورة.');
        }
    } catch (error) {
        console.error("Scanner error:", error);
        setStatus('تم إلغاء السحب أو حدث خطأ في الاتصال.');
        alert("حدث خطأ أثناء السحب: " + error.message.replace('Error: ', ''));
    }
}

window.addEventListener('DOMContentLoaded', () => {
    setTimeout(loadScanners, 800);
});

function imageSource(page) { 
    return page.workingImage || page.originalImage; 
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

async function getBaseCanvas(page) {
    const img = await loadImage(imageSource(page));
    const crop = page.crop || { x: 0, y: 0, w: img.width, h: img.height };
    const base = document.createElement('canvas'); 
    base.width = Math.max(1, Math.round(crop.w)); 
    base.height = Math.max(1, Math.round(crop.h));
    
    const bctx = base.getContext('2d'); 
    bctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, base.width, base.height);
    
    if (page.rotation) {
        const t = document.createElement('canvas');
        const angle = ((page.rotation % 360) + 360) % 360;
        t.width = (angle === 90 || angle === 270) ? base.height : base.width; 
        t.height = (angle === 90 || angle === 270) ? base.width : base.height;
        
        const tc = t.getContext('2d');
        tc.translate(t.width / 2, t.height / 2);
        tc.rotate(angle * Math.PI / 180);
        tc.drawImage(base, -base.width / 2, -base.height / 2);
        return t;
    }
    return base;
}

async function getProcessedCanvas(page) {
    const base = await getBaseCanvas(page);
    processCanvas.width = base.width;
    processCanvas.height = base.height;
    processCtx.clearRect(0, 0, base.width, base.height);
    processCtx.drawImage(base, 0, 0);
    
    if (page.brightness !== 0 || page.contrast !== 0 || page.saturation !== 0 || page.filter !== 'none' || page.cleanBackground || page.sharpness !== 0) {
        const imgData = processCtx.getImageData(0, 0, processCanvas.width, processCanvas.height);
        const data = imgData.data;
        const factor = (259 * (page.contrast + 255)) / (255 * (259 - page.contrast)); 
        const brightOffset = (page.brightness / 100) * 255; 
        const satAmount = (page.saturation + 100) / 100;
        
        for (let i = 0; i < data.length; i += 4) {
            let r = data[i], g = data[i + 1], b = data[i + 2]; 
            r += brightOffset; g += brightOffset; b += brightOffset;
            r = factor * (r - 128) + 128; 
            g = factor * (g - 128) + 128; 
            b = factor * (b - 128) + 128;
            r = Math.max(0, Math.min(255, r)); 
            g = Math.max(0, Math.min(255, g)); 
            b = Math.max(0, Math.min(255, b));
            
            if (page.saturation !== 0) {
                const gray = 0.2989 * r + 0.587 * g + 0.114 * b;
                r = gray + satAmount * (r - gray);
                g = gray + satAmount * (g - gray);
                b = gray + satAmount * (b - gray);
            }
            if (page.filter === 'bw') {
                const v = (0.2126 * r + 0.7152 * g + 0.0722 * b) > 127 ? 255 : 0;
                r = g = b = v;
            } else if (page.filter === 'gray' || page.filter === 'document') {
                let v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                r = g = b = v;
                if (page.filter === 'document' || page.cleanBackground) {
                    if (r > 190) r = g = b = 255;
                    else if (r < 100) r = g = b = Math.max(0, r - 30);
                }
            } else if (page.cleanBackground && r > 200 && g > 200 && b > 200) {
                r = g = b = 255;
            }
            data[i] = Math.max(0, Math.min(255, r));
            data[i + 1] = Math.max(0, Math.min(255, g));
            data[i + 2] = Math.max(0, Math.min(255, b));
        }
        processCtx.putImageData(imgData, 0, 0); 
        if (page.sharpness > 0) applySharpen(processCtx, processCanvas.width, processCanvas.height, page.sharpness);
    }
    const out = document.createElement('canvas');
    out.width = processCanvas.width;
    out.height = processCanvas.height;
    out.getContext('2d').drawImage(processCanvas, 0, 0);
    return out;
}

function applySharpen(ctx, w, h, strength) {
    if (w < 3 || h < 3) return;
    const amount = strength / 100, center = 4 * amount + 1, edge = -amount;
    const data = ctx.getImageData(0, 0, w, h), dst = new ImageData(w, h), s = data.data, d = dst.data;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
                let val = s[i + c] * center + s[i - 4 + c] * edge + s[i + 4 + c] * edge + s[i - w * 4 + c] * edge + s[i + w * 4 + c] * edge;
                d[i + c] = Math.max(0, Math.min(255, val));
            }
            d[i + 3] = s[i + 3];
        }
    }
    for (let x = 0; x < w; x++) {
        let i = x * 4, j = ((h - 1) * w + x) * 4;
        d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = s[i + 3];
        d[j] = s[j]; d[j + 1] = s[j + 1]; d[j + 2] = s[j + 2]; d[j + 3] = s[j + 3];
    }
    for (let y = 0; y < h; y++) {
        let i = (y * w) * 4, j = (y * w + w - 1) * 4;
        for (let c = 0; c < 4; c++) {
            d[i + c] = s[i + c]; d[j + c] = s[j + c];
        }
    }
    ctx.putImageData(dst, 0, 0);
}

async function renderMainCanvas() {
    if (project.currentIndex === -1) return;
    const page = project.pages[project.currentIndex];
    try {
        const result = await getProcessedCanvas(page);
        mainCanvas.width = result.width;
        mainCanvas.height = result.height;
        mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
        mainCtx.drawImage(result, 0, 0);
        document.getElementById('preview-info').innerText = `مقاس المعاينة: ${mainCanvas.width} × ${mainCanvas.height} بيكسل • الصفحة ${project.currentIndex + 1} من ${project.pages.length}`;
        if (cropState.active) {
            requestAnimationFrame(() => {
                clampCropPoints();
                updateCropOverlayUI();
            });
        }
    } catch (e) {
        setStatus('تعذر عرض الصورة الحالية.');
    }
}

function getCanvasDisplayRect() { return mainCanvas.getBoundingClientRect(); }

function defaultCropPoints() {
    const r = getCanvasDisplayRect(), m = Math.max(12, Math.min(r.width, r.height) * .06);
    return [{ x: m, y: m }, { x: r.width - m, y: m }, { x: r.width - m, y: r.height - m }, { x: m, y: r.height - m }];
}

function updateCropOverlayUI() {
    if (!cropState.active) return;
    const o = document.getElementById('crop-overlay'), c = getCanvasDisplayRect(), box = document.getElementById('canvas-container').getBoundingClientRect();
    o.style.left = (c.left - box.left) + 'px';
    o.style.top = (c.top - box.top) + 'px';
    o.style.width = c.width + 'px';
    o.style.height = c.height + 'px';
    const p = cropState.points;
    document.getElementById('crop-polygon').setAttribute('points', p.map(x => `${x.x},${x.y}`).join(' '));
    [['crop-grid-1', p[0], p[2]], ['crop-grid-2', p[1], p[3]], ['crop-grid-3', p[0], p[1]], ['crop-grid-4', p[3], p[2]]].forEach(([id, a, b]) => {
        let e = document.getElementById(id);
        if (e) { e.setAttribute('x1', a.x); e.setAttribute('y1', a.y); e.setAttribute('x2', b.x); e.setAttribute('y2', b.y); }
    });
    p.forEach((x, i) => {
        let h = o.querySelector(`.crop-handle[data-point="${i}"]`), l = o.querySelector(`.crop-point-label[data-label="${i}"]`);
        if (h) { h.style.left = x.x + 'px'; h.style.top = x.y + 'px'; }
        if (l) { l.style.left = x.x + 'px'; l.style.top = x.y + 'px'; }
    });
}

function clampCropPoints() {
    const r = getCanvasDisplayRect();
    if (!r.width || !r.height) return;
    cropState.points = (cropState.points || defaultCropPoints()).map(p => ({ x: Math.max(0, Math.min(r.width, p.x)), y: Math.max(0, Math.min(r.height, p.y)) }));
}

function clampCropToCanvas() {
    clampCropPoints();
}

function toggleManualCrop() {
    if (project.currentIndex === -1) return;
    const o = document.getElementById('crop-overlay'), b = document.getElementById('btn-confirm-crop'), m = document.getElementById('btn-manual-crop');
    if (cropState.active) {
        cropState.active = false; cropState.isDragging = false;
        o.style.display = 'none'; b.style.display = 'none';
        if (m) m.classList.remove('bg-brand-primary', 'text-white');
        setStatus('تم إيقاف القص اليدوي.');
        return;
    }
    cropState.active = true; cropState.points = defaultCropPoints();
    o.style.display = 'block'; b.style.display = 'flex';
    if (m) m.classList.add('bg-brand-primary', 'text-white');
    updateCropOverlayUI();
    setStatus('القص الحر: حرّك كل نقطة مستقلة ثم اضغط حفظ القص.');
}

function beginCropPoint(e, i) {
    if (!cropState.active) return;
    e.preventDefault(); e.stopPropagation();
    cropState.isDragging = true; cropState.dragType = 'point'; cropState.dragPoint = i;
    cropState.startX = e.clientX; cropState.startY = e.clientY;
    cropState.startPoints = cropState.points.map(p => ({ ...p }));
    cropState.moved = false;
}

function beginCropMove(e) {
    if (!cropState.active) return;
    e.preventDefault(); e.stopPropagation();
    cropState.isDragging = true; cropState.dragType = 'move';
    cropState.startX = e.clientX; cropState.startY = e.clientY;
    cropState.startPoints = cropState.points.map(p => ({ ...p }));
    cropState.moved = false;
}

function setupCropEvents() {
    const o = document.getElementById('crop-overlay');
    if (!o) return;
    o.querySelectorAll('.crop-handle').forEach(h => h.addEventListener('pointerdown', e => beginCropPoint(e, +h.dataset.point)));
    document.getElementById('crop-polygon').addEventListener('pointerdown', beginCropMove);
    window.addEventListener('pointermove', e => {
        if (!cropState.isDragging) return;
        const r = getCanvasDisplayRect(), dx = e.clientX - cropState.startX, dy = e.clientY - cropState.startY;
        let p = cropState.startPoints.map(x => ({ ...x }));
        cropState.moved = true;
        if (cropState.dragType === 'point') {
            const i = cropState.dragPoint;
            p[i].x = Math.max(0, Math.min(r.width, p[i].x + dx));
            p[i].y = Math.max(0, Math.min(r.height, p[i].y + dy));
        } else {
            const minX = Math.min(...p.map(x => x.x)), maxX = Math.max(...p.map(x => x.x)), minY = Math.min(...p.map(x => x.y)), maxY = Math.max(...p.map(x => x.y));
            const tx = Math.max(-minX, Math.min(r.width - maxX, dx)), ty = Math.max(-minY, Math.min(r.height - maxY, dy));
            p = p.map(x => ({ x: x.x + tx, y: x.y + ty }));
        }
        cropState.points = p;
        updateCropOverlayUI();
        e.preventDefault();
    }, { passive: false });
    window.addEventListener('pointerup', () => {
        if (cropState.isDragging) {
            cropState.isDragging = false; cropState.dragType = null; cropState.dragPoint = -1;
            if (cropState.moved) setStatus('تم تعديل نقاط القص. اضغط حفظ القص لتطبيقها.');
        }
    });
    window.addEventListener('resize', () => { if (cropState.active) { clampCropPoints(); updateCropOverlayUI(); } });
}

function polygonArea(p) { 
    let a = 0; 
    for (let i = 0; i < p.length; i++) { 
        let j = (i + 1) % p.length; 
        a += p[i].x * p[j].y - p[j].x * p[i].y; 
    } 
    return Math.abs(a / 2); 
}

function orderPoints(pts) {
    const sortedY = pts.slice().sort((a, b) => a.y - b.y);
    const top = sortedY.slice(0, 2).sort((a, b) => a.x - b.x);
    const bottom = sortedY.slice(2, 4).sort((a, b) => a.x - b.x);
    return [top[0], top[1], bottom[1], bottom[0]];
}

function solveLinearSystem(A, b) {
    const n = b.length, M = A.map((row, i) => row.slice().concat([b[i]]));
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
        if (Math.abs(M[pivot][col]) < 1e-10) return null;
        [M[col], M[pivot]] = [M[pivot], M[col]];
        const div = M[col][col];
        for (let c = col; c <= n; c++) M[col][c] /= div;
        for (let r = 0; r < n; r++) if (r !== col) { const f = M[r][col]; if (!f) continue; for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]; }
    }
    return M.map(row => row[n]);
}

function getHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
        const x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
        A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
        A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solveLinearSystem(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function perspectiveWarpCanvas(canvas, points, outW, outH) {
    const src = orderPoints(points);
    const dst = [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }];
    const H = getHomography(dst, src);
    if (!H) return null;
    
    const out = document.createElement('canvas'); 
    out.width = Math.max(20, Math.round(outW)); 
    out.height = Math.max(20, Math.round(outH));
    const sctx = canvas.getContext('2d'), dctx = out.getContext('2d');
    const srcData = sctx.getImageData(0, 0, canvas.width, canvas.height);
    const dstData = dctx.createImageData(out.width, out.height);
    const S = srcData.data, D = dstData.data;
    
    for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
            const den = H[6] * x + H[7] * y + H[8];
            const sx = (H[0] * x + H[1] * y + H[2]) / den;
            const sy = (H[3] * x + H[4] * y + H[5]) / den;
            const di = (y * out.width + x) * 4;
            
            if (sx < 0 || sy < 0 || sx >= canvas.width - 1 || sy >= canvas.height - 1) { 
                D[di] = 255; D[di + 1] = 255; D[di + 2] = 255; D[di + 3] = 255; 
                continue; 
            }
            const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
            const i00 = (y0 * canvas.width + x0) * 4, i10 = i00 + 4, i01 = i00 + canvas.width * 4, i11 = i01 + 4;
            for (let c = 0; c < 3; c++) { 
                const a = S[i00 + c] * (1 - fx) + S[i10 + c] * fx;
                const b = S[i01 + c] * (1 - fx) + S[i11 + c] * fx; 
                D[di + c] = Math.round(a * (1 - fy) + b * fy); 
            } 
            D[di + 3] = 255;
        }
    }
    dctx.putImageData(dstData, 0, 0); 
    return out;
}

function manualPerspectiveCrop(canvas, dp) {
    const r = getCanvasDisplayRect();
    const sx = canvas.width / Math.max(1, r.width);
    const sy = canvas.height / Math.max(1, r.height);
    const p = orderPoints(dp.map(x => ({ x: x.x * sx, y: x.y * sy })));
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const w = Math.max(20, Math.round(Math.max(d(p[0], p[1]), d(p[3], p[2]))));
    const h = Math.max(20, Math.round(Math.max(d(p[0], p[3]), d(p[1], p[2]))));
    
    const warped = perspectiveWarpCanvas(canvas, p, w, h);
    if (warped) return warped;

    const minX = Math.max(0, Math.floor(Math.min(...p.map(pt => pt.x))));
    const maxX = Math.min(canvas.width, Math.ceil(Math.max(...p.map(pt => pt.x))));
    const minY = Math.max(0, Math.floor(Math.min(...p.map(pt => pt.y))));
    const maxY = Math.min(canvas.height, Math.ceil(Math.max(...p.map(pt => pt.y))));
    const fallback = document.createElement('canvas');
    fallback.width = Math.max(20, maxX - minX);
    fallback.height = Math.max(20, maxY - minY);
    fallback.getContext('2d').drawImage(canvas, minX, minY, fallback.width, fallback.height, 0, 0, fallback.width, fallback.height);
    return fallback;
}

async function confirmCrop() {
    if (!cropState.active || project.currentIndex === -1) return;
    const page = project.pages[project.currentIndex];
    const c = await getBaseCanvas(page);
    const pts = cropState.points.map(p => ({ ...p }));
    
    if (polygonArea(pts) < 150) return alert('منطقة القص صغيرة جداً. حرّك النقاط الأربع حول المستند.');
    
    const out = manualPerspectiveCrop(c, pts);
    const w = out.width, h = out.height;
    page.workingImage = out.toDataURL('image/jpeg', 0.96);
    page.thumbnail = generateThumbnailDataUrl(out);
    page.width = w; 
    page.height = h; 
    page.crop = { x: 0, y: 0, w, h }; 
    page.rotation = 0;
    
    cropState.active = false; 
    cropState.isDragging = false;
    document.getElementById('crop-overlay').style.display = 'none'; 
    document.getElementById('btn-confirm-crop').style.display = 'none';
    const manualBtn = document.getElementById('btn-manual-crop');
    if (manualBtn) manualBtn.classList.remove('bg-brand-primary', 'text-white');
    
    renderThumbnails(); 
    await renderMainCanvas(); 
    await autoSaveSession();
    setStatus('تم قص البطاقة وتعديل الميلان (السنترة) بنجاح!');
}

function applyFastCrop() {
    if (project.currentIndex === -1) return;
    const p = project.pages[project.currentIndex];
    const mX = p.crop.w * .05, mY = p.crop.h * .05;
    p.crop.x += mX; p.crop.y += mY;
    p.crop.w = Math.max(1, p.crop.w - mX * 2); p.crop.h = Math.max(1, p.crop.h - mY * 2);
    renderMainCanvas();
    setStatus('تم القص السريع بنسبة 5%. احفظ المشروع لحفظ التغييرات دائماً.');
}

async function autoDetectDocument() {
    if (project.currentIndex === -1) return alert('الرجاء اختيار أو استيراد صورة أولاً.'); 
    const p = project.pages[project.currentIndex]; 
    setStatus('جاري التعرف الذكي على حدود الهوية وتحديد النقاط الأربع...');
    
    try {
        const base = await getBaseCanvas(p);
        const sourceDataUrl = base.toDataURL('image/jpeg', 0.92);
        const normalizedCorners = await window.api.detectCorners(sourceDataUrl);
        
        if (normalizedCorners && normalizedCorners.length === 4) {
            const rect = getCanvasDisplayRect();
            cropState.active = true;
            cropState.isDragging = false;
            cropState.points = normalizedCorners.map(pt => ({
                x: pt.x * rect.width,
                y: pt.y * rect.height
            }));
            
            document.getElementById('crop-overlay').style.display = 'block';
            document.getElementById('btn-confirm-crop').style.display = 'flex';
            const manualBtn = document.getElementById('btn-manual-crop');
            if (manualBtn) manualBtn.classList.add('bg-brand-primary', 'text-white');
            
            updateCropOverlayUI();
            setStatus('تم تحديد الهوية بالذكاء الاصطناعي! اضغط على (حفظ القص) في الأعلى لقصها وتعديل ميلانها.');
        } else {
            setStatus('تعذر تحديد الزوايا تلقائياً.');
        }
    } catch (e) { 
        console.error(e); 
        setStatus('حدث خطأ أثناء التعرف الذكي.'); 
        alert('خطأ في التعرف الذكي: ' + e.message); 
    }
}

async function quickScanCurrentPage() {
    if (project.currentIndex === -1) return alert('أضف صورة أو PDF أولاً، ثم حدد الصفحة.');
    await autoDetectDocument();
}

function initDB() { return new Promise((resolve, reject) => { const req = indexedDB.open(dbName, dbVersion); req.onupgradeneeded = e => { const db = e.target.result; if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects'); }; req.onsuccess = e => resolve(e.target.result); req.onerror = () => reject(req.error); }); }
function cloneProjectData() { return { pages: project.pages, currentIndex: project.currentIndex }; }
async function autoSaveSession() {
    if (!project.pages.length) return; try { const db = await initDB(); const tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').put({ id: 'lastSession', name: currentProjectName, updatedAt: Date.now(), data: cloneProjectData(), type: 'session' }, 'lastSession'); } catch (e) { }
}

async function saveProject(silent = false) {
    if (!project.pages.length && !currentFilePath) {
        if (!silent) alert('لا توجد صفحات حالياً. أضف صوراً أو PDF أولاً، ثم احفظ المشروع.');
        return;
    }
    setStatus('جاري تجهيز المشروع للحفظ...');
    const projectData = JSON.stringify({ name: currentProjectName, updatedAt: Date.now(), data: cloneProjectData() });
    try {
        const savedPath = await window.api.saveProjectFile(projectData, currentProjectName + '.ssp', silent ? currentFilePath : null);
        if (savedPath) {
            currentFilePath = savedPath;
            setStatus(`تم حفظ المشروع بنجاح في: ${savedPath}`);
            if (!silent) alert('تم حفظ المشروع كملف حقيقي بنجاح!');
        } else {
            setStatus('تم إلغاء عملية الحفظ.');
        }
    } catch (error) {
        console.error(error);
        setStatus('حدث خطأ أثناء الحفظ.');
        if (!silent) alert('تعذر حفظ الملف: ' + error.message);
    }
}

function txComplete(tx) { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed')); tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted')); }); }
async function restoreProject() {
    setStatus('جاري استرجاع آخر عمل...'); try { const db = await initDB(); const rec = await new Promise((resolve, reject) => { const tx = db.transaction('projects', 'readonly'); const r = tx.objectStore('projects').get('lastSession'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); if (!rec) { setStatus('لا يوجد عمل محفوظ سابقاً.'); return; } loadProjectRecord(rec, null); setStatus('تم استرجاع آخر عمل بنجاح. يمكنك حفظه باسم مشروع مستقل.'); } catch (e) { setStatus('خطأ في الاسترجاع.'); }
}

function loadProjectRecord(rec, filePath) {
    const data = rec.data || rec;
    if (!data || !Array.isArray(data.pages)) {
        throw new Error('بنية ملف المشروع غير صالحة.');
    }
    project = {
        pages: data.pages.map(normalizePage),
        currentIndex: Number.isInteger(data.currentIndex) ? data.currentIndex : -1
    };
    currentFilePath = filePath || null;
    currentProjectName = String(rec.name || 'مشروع جديد').slice(0, 80);
    updateProjectNameUI();
    renderThumbnails();
    selectPage(project.pages.length ? (project.currentIndex >= 0 && project.currentIndex < project.pages.length ? project.currentIndex : 0) : -1);
}

async function newProject() {
    if (project.pages.length && !confirm('هل تريد إنشاء مشروع جديد؟ التغييرات غير المحفوظة في المشروع الحالي لن تنتقل للمشروع الجديد.')) return;
    project = { pages: [], currentIndex: -1 }; currentProjectId = null; currentFilePath = null; currentProjectName = 'مشروع جديد'; updateProjectNameUI(); renderThumbnails(); setStatus('تم فتح مشروع جديد فارغ.');
}

function customPrompt(message, defaultValue, callback) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.className = 'bg-gray-800 border border-gray-600 rounded-lg shadow-xl p-6 w-96 text-center';
    const title = document.createElement('h3');
    title.className = 'text-white text-lg mb-4'; title.textContent = message;
    const input = document.createElement('input');
    input.type = 'text'; input.value = defaultValue;
    input.className = 'w-full bg-gray-900 border border-gray-600 text-white rounded p-2 text-right mb-6 outline-none focus:border-brand-primary';
    const btnContainer = document.createElement('div');
    btnContainer.className = 'flex justify-center gap-3';
    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'إلغاء';
    btnCancel.className = 'bg-gray-600 hover:bg-gray-500 text-white px-4 py-2 rounded transition';
    btnCancel.onclick = () => { document.body.removeChild(overlay); callback(null); };
    const btnOk = document.createElement('button');
    btnOk.textContent = 'حفظ الاسم';
    btnOk.className = 'bg-brand-primary hover:bg-brand-primaryHover text-white px-4 py-2 rounded transition font-bold';
    btnOk.onclick = () => { document.body.removeChild(overlay); callback(input.value); };
    btnContainer.appendChild(btnCancel); btnContainer.appendChild(btnOk); box.appendChild(title); box.appendChild(input); box.appendChild(btnContainer); overlay.appendChild(box); document.body.appendChild(overlay);
    input.focus(); input.select();
}

function renameCurrentProject() {
    customPrompt('أدخل اسم المشروع الجديد:', currentProjectName, async (name) => {
        if (!name || !name.trim()) return;
        currentProjectName = name.trim().slice(0, 80);
        updateProjectNameUI();
        await autoSaveSession();
        if (currentFilePath) {
            await saveProject(true);
        }
        setStatus(`تم تغيير اسم المشروع إلى «${currentProjectName}».`);
    });
}

async function deleteCurrentProject() {
    if (!currentFilePath && !project.pages.length) return newProject();
    if (!confirm(`هل تريد حذف المشروع «${currentProjectName}» وإفراغ مساحة العمل؟`)) return;
    try {
        if (currentFilePath) {
            await window.api.trashProjectFile(currentFilePath);
        }
        project = { pages: [], currentIndex: -1 };
        currentProjectId = null;
        currentFilePath = null;
        currentProjectName = 'مشروع جديد';
        updateProjectNameUI();
        renderThumbnails();
        setStatus('تم نقل ملف المشروع إلى سلة المحذوفات وفتح مساحة جديدة.');
    } catch (e) {
        setStatus('تعذر حذف المشروع.');
    }
}

async function openProjectModal() {
    try {
        setStatus('جاري فتح نافذة اختيار الملفات...');
        const result = await window.api.openProjectFile();
        if (result && result.data) {
            const parsed = JSON.parse(result.data);
            loadProjectRecord(parsed, result.path);
            setStatus(`تم فتح المشروع بنجاح.`);
        } else {
            setStatus('تم إلغاء فتح المشروع.');
        }
    } catch (error) {
        console.error(error);
        setStatus('الملف غير صالح أو حدث خطأ في القراءة.');
        alert('تعذر فتح المشروع: تأكد من أن الملف بصيغة .ssp سليمة وغير تالفة.');
    }
}

function closeProjectModal() { 
    const modal = document.getElementById('projects-modal'); 
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

async function exportPDF() {
    if (!project.pages.length) return alert('لا توجد صفحات للتصدير.'); 
    setStatus('جاري إنشاء PDF...'); 
    const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    for (let i = 0; i < project.pages.length; i++) {
        const canvas = await getProcessedCanvas(project.pages[i]);
        const imgData = canvas.toDataURL('image/jpeg', .95);
        const ratio = Math.min(210 / canvas.width, 297 / canvas.height);
        const w = canvas.width * ratio, h = canvas.height * ratio, x = (210 - w) / 2, y = (297 - h) / 2;
        if (i > 0) doc.addPage();
        doc.addImage(imgData, 'JPEG', x, y, w, h);
    }
    doc.save('smart-scanner-document.pdf'); 
    setStatus('تم حفظ PDF بنجاح.');
}

async function exportImages() { 
    if (!project.pages.length) return alert('لا توجد صفحات للتصدير.'); 
    setStatus('جاري التصدير...'); 
    for (let i = 0; i < project.pages.length; i++) { 
        const canvas = await getProcessedCanvas(project.pages[i]); 
        const link = document.createElement('a'); 
        link.download = `scanned-page-${String(i + 1).padStart(2, '0')}.jpg`; 
        link.href = canvas.toDataURL('image/jpeg', .92); 
        link.click(); 
        await new Promise(r => setTimeout(r, 80)); 
    } 
    setStatus('تم حفظ الصور بنجاح.'); 
}

// ==================== نظام الطباعة الذكي ====================

let useCmSizeMode = true;
let previewRenderToken = 0;
let printDragStartIndex = -1;
let selectedPrintCardIndex = -1;

function injectSelectionBanner() {
    if (document.getElementById('print-selection-banner')) return;
    const wInput = document.getElementById('print-card-w');
    if (!wInput) return;
    const gridBox = wInput.closest('.grid');
    if (!gridBox) return;

    const banner = document.createElement('div');
    banner.id = 'print-selection-banner';
    banner.className = 'bg-slate-800/90 border border-slate-600 rounded-lg p-2 mb-2 flex justify-between items-center text-xs transition-all';
    gridBox.parentElement.insertBefore(banner, gridBox);
    updateSelectionBannerUI();
}

function updateSelectionBannerUI() {
    const banner = document.getElementById('print-selection-banner');
    if (!banner) return;

    if (selectedPrintCardIndex === -1 || !project.pages[selectedPrintCardIndex]) {
        banner.className = 'bg-slate-800/90 border border-slate-600 rounded-lg p-2 mb-2 flex justify-between items-center text-xs text-slate-300';
        banner.innerHTML = `
            <span>🌐 <b>التحكم بالحجم:</b> جميع البطاقات معاً</span>
            <span class="text-[10px] text-slate-400">اضغط على بطاقة لتخصيصها</span>
        `;
    } else {
        const p = project.pages[selectedPrintCardIndex];
        banner.className = 'bg-blue-950/90 border border-blue-500 rounded-lg p-2 mb-2 flex justify-between items-center text-xs text-blue-200 shadow-md';
        banner.innerHTML = `
            <span>🎯 <b>محدد:</b> بطاقة رقم #${Number(selectedPrintCardIndex) + 1} فقط</span>
            <button type="button" onclick="selectPrintCard(-1)" class="bg-blue-600 hover:bg-blue-500 text-white px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer">تحديد الكل</button>
        `;
        const wInput = document.getElementById('print-card-w');
        const hInput = document.getElementById('print-card-h');
        if (wInput && p.customW_cm) wInput.value = p.customW_cm;
        if (hInput && p.customH_cm) hInput.value = p.customH_cm;
    }
}

window.selectPrintCard = function(index) {
    selectedPrintCardIndex = index;
    updateSelectionBannerUI();
    generatePrintPreview();
};

window.isGoldenSquareMode = false;

window.applyGoldenSquare = function() {
    window.isGoldenSquareMode = true;
    useCmSizeMode = true;

    project.pages.forEach((p, idx) => {
        if (idx === 0) {
            p.customW_cm = 9.5;
            p.customH_cm = 20.5;
        } else {
            p.customW_cm = 8.6;
            p.customH_cm = 5.4;
        }
    });

    selectedPrintCardIndex = 0; 
    updateSelectionBannerUI();
    generatePrintPreview();
};

window.applyPrintPreset = function(mode, wCm, hCm, cols, margin, spacing) {
    window.isGoldenSquareMode = false;
    useCmSizeMode = true;

    if (mode !== 'cm' || cols === 1) {
        wCm = 19.0;
        hCm = 27.7;
        cols = 1;
        if (document.getElementById('print-rows')) document.getElementById('print-rows').value = 1;
    } else {
        if (document.getElementById('print-rows')) document.getElementById('print-rows').value = 4;
    }

    const wInput = document.getElementById('print-card-w');
    const hInput = document.getElementById('print-card-h');
    if (wInput && wCm) wInput.value = wCm;
    if (hInput && hCm) hInput.value = hCm;

    if (selectedPrintCardIndex !== -1 && project.pages[selectedPrintCardIndex]) {
        project.pages[selectedPrintCardIndex].customW_cm = wCm;
        project.pages[selectedPrintCardIndex].customH_cm = hCm;
    } else {
        project.pages.forEach(p => { p.customW_cm = wCm; p.customH_cm = hCm; });
        if (cols !== undefined && document.getElementById('print-cols')) document.getElementById('print-cols').value = cols;
        if (margin !== undefined && document.getElementById('print-margin')) document.getElementById('print-margin').value = margin;
        if (spacing !== undefined && document.getElementById('print-spacing')) document.getElementById('print-spacing').value = spacing;
    }
    updateSelectionBannerUI();
    generatePrintPreview();
};

function bindPrintInputs() {
    const duplicateBox = document.getElementById('cm-controls-box');
    if (duplicateBox) duplicateBox.remove();

    injectSelectionBanner();

    const ids = ['print-card-w', 'print-card-h', 'print-cols', 'print-rows', 'print-orientation', 'print-margin', 'print-spacing', 'print-paper'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const handler = () => {
                if (id === 'print-card-w' || id === 'print-card-h') {
                    useCmSizeMode = true;
                    const wVal = parseFloat(document.getElementById('print-card-w')?.value) || 8.6;
                    const hVal = parseFloat(document.getElementById('print-card-h')?.value) || 5.4;
                    if (selectedPrintCardIndex !== -1 && project.pages[selectedPrintCardIndex]) {
                        project.pages[selectedPrintCardIndex].customW_cm = wVal;
                        project.pages[selectedPrintCardIndex].customH_cm = hVal;
                    } else {
                        project.pages.forEach(p => { p.customW_cm = wVal; p.customH_cm = hVal; });
                    }
                }
                generatePrintPreview();
            };
            el.oninput = handler;
            el.onchange = handler;
        }
    });
}

function openPrintModal() { 
    if (!project.pages.length) return alert('لا توجد صفحات للطباعة.'); 
    const modal = document.getElementById('print-modal');
    modal.classList.remove('hidden'); 
    modal.style.display = 'flex';
    
    const countEl = document.getElementById('print-img-count');
    if (countEl) countEl.innerText = project.pages.length; 

    const defaultW = parseFloat(document.getElementById('print-card-w')?.value) || 8.6;
    const defaultH = parseFloat(document.getElementById('print-card-h')?.value) || 5.4;

    project.pages.forEach(p => {
        if (!p.customW_cm || !p.customH_cm) {
            p.customW_cm = defaultW;
            p.customH_cm = defaultH;
        }
    });

    selectedPrintCardIndex = -1;
    bindPrintInputs();
    updateSelectionBannerUI();
    generatePrintPreview(); 
}

function closePrintModal() { 
    const modal = document.getElementById('print-modal');
    modal.classList.add('hidden'); 
    modal.style.display = 'none';
}

async function executePrint() {
    if (project.pages.length === 0) return alert('لا توجد صفحات للطباعة.');
    setStatus('جاري تجهيز الطباعة بالقياسات المخصصة لكل بطاقة...');
    
    const rows = Math.max(1, parseInt(document.getElementById('print-rows')?.value, 10) || 4);
    const cols = Math.max(1, parseInt(document.getElementById('print-cols')?.value, 10) || 2);
    const margin = Math.max(0, parseFloat(document.getElementById('print-margin')?.value) || 12);
    const spacing = Math.max(0, parseFloat(document.getElementById('print-spacing')?.value) || 6);
    const orientation = document.getElementById('print-orientation')?.value === 'landscape' ? 'landscape' : 'portrait';
    const allowedPapers = ['A4', 'A5', 'Letter'];
    const rawPaper = document.getElementById('print-paper')?.value || 'A4';
    const paper = allowedPapers.includes(rawPaper) ? rawPaper : 'A4';
    
    let pW = 210, pH = 297;
    if (paper === 'A5') { pW = 148; pH = 210; }
    if (paper === 'Letter') { pW = 216; pH = 279; }
    if (orientation === 'landscape') [pW, pH] = [pH, pW];
    
    const defaultW_cm = parseFloat(document.getElementById('print-card-w')?.value) || 8.6;
    const defaultH_cm = parseFloat(document.getElementById('print-card-h')?.value) || 5.4;
    const pagesPerSheet = Math.max(1, rows * cols);
    const sheets = [];
    const fitMode = 'contain';    

    if (window.isGoldenSquareMode) {
        const getPrintDiv = async (index) => {
            const page = project.pages[index];
            if (!page) return '';
            const defW = index === 0 ? 9.5 : 8.6;
            const defH = index === 0 ? 20.5 : 5.4;
            const wMm = (Number(page.customW_cm) || defW) * 10;
            const hMm = (Number(page.customH_cm) || defH) * 10;
            let src = '';
            try { 
                const processed = await getProcessedCanvas(page); 
                src = processed.toDataURL('image/jpeg', 0.95); 
            } catch (e) { 
                src = isSafeDataImageUrl(imageSource(page)) ? imageSource(page) : ''; 
            }
            return `<div style="width:${wMm}mm; height:${hMm}mm; display:flex; justify-content:center; align-items:center; overflow:hidden;"><img src="${src}" style="width:100%; height:100%; object-fit:contain;"></div>`;
        };

        const div0 = await getPrintDiv(0);
        const div1 = await getPrintDiv(1);
        const div2 = await getPrintDiv(2);
        const div3 = await getPrintDiv(3);
        const div4 = await getPrintDiv(4);

        sheets.push(`
            <section class="print-sheet" style="width:${pW}mm; height:${pH}mm; padding:8mm; display:flex; flex-direction:row; direction:ltr; gap:8mm; box-sizing:border-box; background:#fff; align-items:center; justify-content:space-between;">
                <div style="flex: 1; height: 100%; display: flex; justify-content: center; align-items: center;">
                    ${div0}
                </div>
                <div style="flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; gap:6mm;">
                    ${[div1, div2, div3, div4].map(d => `<div style="display: flex; justify-content: center; align-items: center;">${d}</div>`).join('')}
                </div>
            </section>
        `);
    } else {
        for (let offset = 0; offset < project.pages.length; offset += pagesPerSheet) {
            const chunk = project.pages.slice(offset, offset + pagesPerSheet);
            const cells = [];
            for (let i = 0; i < chunk.length; i++) {
                const page = chunk[i];
                const wMm = (Number(page.customW_cm) || defaultW_cm) * 10;
                const hMm = (Number(page.customH_cm) || defaultH_cm) * 10;
                let src = '';
                try { 
                    const processed = await getProcessedCanvas(page); 
                    src = processed.toDataURL('image/jpeg', .95); 
                } catch (e) { 
                    src = isSafeDataImageUrl(imageSource(page)) ? imageSource(page) : ''; 
                }
                if (useCmSizeMode) {
                    cells.push(`<div class="print-cell" style="width:${wMm}mm;height:${hMm}mm;"><img src="${src}" alt="page ${offset + i + 1}"></div>`);
                } else {
                    cells.push(`<div class="print-cell" style="width:100%;height:100%;"><img src="${src}" alt="page ${offset + i + 1}"></div>`);
                }
            }
            if (useCmSizeMode) {
                sheets.push(`<section class="print-sheet" style="width:${pW}mm;height:${pH}mm;padding-top:${margin}mm;padding-bottom:${margin}mm;gap:${spacing}mm;grid-template-columns:repeat(${cols}, auto);grid-auto-rows:auto;place-items:center;">${cells.join('')}</section>`);
            } else {
                const innerW = Math.max(1, pW - margin * 2), innerH = Math.max(1, pH - margin * 2);
                const cellW = Math.max(1, (innerW - spacing * (cols - 1)) / cols);
                const cellH = Math.max(1, (innerH - spacing * (rows - 1)) / rows);
                sheets.push(`<section class="print-sheet" style="width:${pW}mm;height:${pH}mm;padding:${margin}mm;gap:${spacing}mm;grid-template-columns:repeat(${cols},${cellW}mm);grid-auto-rows:${cellH}mm">${cells.join('')}</section>`);
            }
        }
    }
    
    const printHtml = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>طباعة</title><style>
        @page{size:${paper} ${orientation};margin:0}
        *{box-sizing:border-box}
        html,body{margin:0;padding:0;background:#fff}
        body{font-family:Arial,sans-serif}
        .print-sheet{box-sizing:border-box;display:grid;align-content:start;justify-content:center;page-break-after:always;break-after:page;overflow:hidden;background:#fff}
        .print-sheet:last-child{page-break-after:auto;break-after:auto}
        .print-cell{display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid #e5e7eb}
        .print-cell img{display:block;width:100%;height:100%;object-fit:${fitMode}}
        @media screen{body{background:#777}.print-sheet{margin:10px auto;box-shadow:0 0 8px #222}}
        @media print{html,body{width:${pW}mm;min-height:${pH}mm}.print-sheet{margin:0;box-shadow:none}}
    </style></head><body>${sheets.join('')}</body></html>`;
    
    let iframe = document.getElementById('print-iframe');
    if (!iframe) { 
        iframe = document.createElement('iframe'); 
        iframe.id = 'print-iframe'; 
        iframe.style.position = 'fixed'; 
        iframe.style.right = '-10000px'; 
        iframe.style.bottom = '0'; 
        iframe.style.width = '1px'; 
        iframe.style.height = '1px'; 
        iframe.style.border = '0'; 
        document.body.appendChild(iframe); 
    }
    const win = iframe.contentWindow;
    let printed = false;
    const doPrint = () => { 
        if (printed) return; 
        printed = true; 
        win.focus(); 
        win.print(); 
        closePrintModal(); 
        setStatus('تم إرسال الطباعة بالقياسات المحددة.'); 
    };
    win.document.open(); 
    win.document.write(printHtml); 
    win.document.close();
    setTimeout(doPrint, 700);
}

async function generatePrintPreview() {
    const container = document.getElementById('print-preview-paper'); 
    if (!container) return;
    
    const currentToken = ++previewRenderToken;

    if (window.isGoldenSquareMode) {
        const previewScale = 2.2;
        container.style.width = (210 * previewScale) + 'px'; 
        container.style.minHeight = (297 * previewScale) + 'px'; 
        container.style.padding = (8 * previewScale) + 'px';
        container.style.display = 'flex';
        container.style.direction = 'ltr'; 
        container.style.gap = (8 * previewScale) + 'px';
        container.style.backgroundColor = '#ffffff';
        container.style.boxSizing = 'border-box';
        container.style.margin = 'auto';
        container.style.gridTemplateColumns = ''; 
        container.innerHTML = ''; 

        container.onclick = (e) => {
            if (e.target === container) selectPrintCard(-1);
        };

        const leftCol = document.createElement('div');
        leftCol.style.flex = '1';
        leftCol.style.minHeight = '100%';
        leftCol.style.display = 'flex';
        leftCol.style.justifyContent = 'center';
        leftCol.style.alignItems = 'center';

        const rightCol = document.createElement('div');
        rightCol.style.flex = '1';
        rightCol.style.minHeight = '100%';
        rightCol.style.display = 'flex';
        rightCol.style.flexDirection = 'column';
        rightCol.style.gap = (6 * previewScale) + 'px';
        rightCol.style.justifyContent = 'center';
        rightCol.style.alignItems = 'center';

        container.appendChild(leftCol);
        container.appendChild(rightCol);

        const createDraggableDiv = async (index, parent) => {
            const page = project.pages[index];
            const isSelected = (selectedPrintCardIndex === index);
            
            const defW = index === 0 ? 9.5 : 8.6;
            const defH = index === 0 ? 20.5 : 5.4;
            const cardW = page ? (Number(page.customW_cm) || defW) : defW;
            const cardH = page ? (Number(page.customH_cm) || defH) : defH;

            const div = document.createElement('div');
            div.style.width = ((cardW * 10) * previewScale) + 'px';
            div.style.height = ((cardH * 10) * previewScale) + 'px';
            div.style.flexShrink = '0';
            
            div.className = `relative flex items-center justify-center bg-white cursor-grab active:cursor-grabbing transition-shadow group ${isSelected ? 'ring-4 ring-blue-500 shadow-xl z-20' : 'border-2 border-dashed border-gray-400 shadow-sm hover:border-blue-400'}`;
            div.draggable = true;
            div.dataset.index = index;
            div.title = 'اضغط لتحديد البطاقة وتغيير حجمها • أو اسحبها لتبديل مكانها';

            div.addEventListener('click', (e) => {
                e.stopPropagation();
                selectPrintCard(index);
            });

            div.addEventListener('dragstart', (e) => {
                printDragStartIndex = index;
                div.style.opacity = '0.4';
                e.dataTransfer.effectAllowed = 'move';
            });
            div.addEventListener('dragend', () => {
                div.style.opacity = '1';
                printDragStartIndex = -1;
                container.querySelectorAll('div[data-index]').forEach(el => {
                    el.style.outline = 'none';
                    el.style.transform = 'scale(1)';
                });
            });
            div.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (printDragStartIndex !== -1 && printDragStartIndex !== index) {
                    div.style.outline = '3px dashed #10b981';
                    div.style.transform = 'scale(0.97)';
                }
            });
            div.addEventListener('dragleave', () => {
                div.style.outline = 'none';
                div.style.transform = 'scale(1)';
            });
            div.addEventListener('drop', (e) => {
                e.preventDefault();
                if (printDragStartIndex !== -1 && printDragStartIndex !== index) {
                    const w1 = project.pages[printDragStartIndex]?.customW_cm;
                    const h1 = project.pages[printDragStartIndex]?.customH_cm;
                    const w2 = project.pages[index]?.customW_cm;
                    const h2 = project.pages[index]?.customH_cm;

                    const temp = project.pages[printDragStartIndex];
                    project.pages[printDragStartIndex] = project.pages[index];
                    project.pages[index] = temp;

                    if (project.pages[printDragStartIndex]) {
                        project.pages[printDragStartIndex].customW_cm = w1;
                        project.pages[printDragStartIndex].customH_cm = h1;
                    }
                    if (project.pages[index]) {
                        project.pages[index].customW_cm = w2;
                        project.pages[index].customH_cm = h2;
                    }

                    if (project.currentIndex === printDragStartIndex) project.currentIndex = index;
                    else if (project.currentIndex === index) project.currentIndex = printDragStartIndex;
                    if (selectedPrintCardIndex === printDragStartIndex) selectedPrintCardIndex = index;
                    else if (selectedPrintCardIndex === index) selectedPrintCardIndex = printDragStartIndex;
                    
                    printDragStartIndex = -1;
                    renderThumbnails();
                    updateSelectionBannerUI();
                    generatePrintPreview();
                    autoSaveSession();
                }
            });

            if (page) {
                const badge = document.createElement('span');
                badge.className = `absolute top-1 right-1 ${isSelected ? 'bg-blue-600 text-white opacity-100' : 'bg-slate-900/80 text-white opacity-70 group-hover:opacity-100'} text-[10px] font-bold px-1.5 py-0.5 rounded pointer-events-none transition z-10 dir-ltr`;
                badge.textContent = `#${index + 1} (${cardW}×${cardH} cm)`;
                div.appendChild(badge);

                const resizeHandle = document.createElement('div');
                resizeHandle.className = `absolute bottom-0 left-0 w-5 h-5 bg-blue-600 text-white flex items-center justify-center cursor-nwse-resize z-30 rounded-tr-md shadow ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`;
                resizeHandle.innerHTML = `<i class="fa-solid fa-up-right-and-down-left-from-center text-[10px]"></i>`;
                
                resizeHandle.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    div.draggable = false; 
                    selectedPrintCardIndex = index;
                    updateSelectionBannerUI();

                    const startX = e.clientX;
                    const startY = e.clientY;
                    const startW = cardW;
                    const startH = cardH;

                    const onPointerMove = (moveEvent) => {
                        const dx = (startX - moveEvent.clientX) / (10 * previewScale); 
                        const dy = (moveEvent.clientY - startY) / (10 * previewScale);
                        const newW = Math.max(2.0, Math.min(20.0, Math.round((startW + dx) * 10) / 10));
                        const newH = Math.max(2.0, Math.min(28.0, Math.round((startH + dy) * 10) / 10));

                        page.customW_cm = newW;
                        page.customH_cm = newH;
                        div.style.width = ((newW * 10) * previewScale) + 'px';
                        div.style.height = ((newH * 10) * previewScale) + 'px';
                        badge.textContent = `#${index + 1} (${newW}×${newH} cm)`;

                        const wInput = document.getElementById('print-card-w');
                        const hInput = document.getElementById('print-card-h');
                        if (wInput) wInput.value = newW;
                        if (hInput) hInput.value = newH;
                    };

                    const onPointerUp = () => {
                        div.draggable = true;
                        window.removeEventListener('pointermove', onPointerMove);
                        window.removeEventListener('pointerup', onPointerUp);
                        generatePrintPreview();
                    };

                    window.addEventListener('pointermove', onPointerMove);
                    window.addEventListener('pointerup', onPointerUp);
                });
                div.appendChild(resizeHandle);

                const img = document.createElement('img');
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'contain';
                try {
                    const canvas = await getProcessedCanvas(page);
                    if (currentToken !== previewRenderToken) return;
                    img.src = canvas.toDataURL('image/jpeg', 0.92);
                } catch (e) {
                    img.src = imageSource(page);
                }
                div.appendChild(img);
            } else {
                const span = document.createElement('span');
                span.style.color = '#9ca3af';
                span.style.fontWeight = 'bold';
                span.textContent = index === 0 ? 'البطاقة التموينية' : `هوية ${index}`;
                div.appendChild(span);
            }
            
            parent.appendChild(div);
        };

        await createDraggableDiv(0, leftCol);
        for (let i = 1; i < 5; i++) {
            if (currentToken !== previewRenderToken) return;
            await createDraggableDiv(i, rightCol);
        }
        return; 
    }

    const rows = Math.max(1, parseInt(document.getElementById('print-rows')?.value, 10) || 4);
    const cols = Math.max(1, parseInt(document.getElementById('print-cols')?.value, 10) || 2);
    const margin = Math.max(0, parseFloat(document.getElementById('print-margin')?.value) || 12);
    const spacing = Math.max(0, parseFloat(document.getElementById('print-spacing')?.value) || 6);
    const orientation = document.getElementById('print-orientation')?.value || 'portrait';
    const paper = document.getElementById('print-paper')?.value || 'A4';
    
    const valMargin = document.getElementById('val-print-margin');
    if (valMargin) valMargin.innerText = `${margin} mm`;
    const valGap = document.getElementById('val-print-gap');
    if (valGap) valGap.innerText = `${spacing} mm`;

    let pW = 210, pH = 297; 
    if (paper === 'A5') { pW = 148; pH = 210; } 
    if (paper === 'Letter') { pW = 216; pH = 279; } 
    if (orientation === 'landscape') [pW, pH] = [pH, pW]; 

    const defaultW_cm = parseFloat(document.getElementById('print-card-w')?.value) || 8.6;
    const defaultH_cm = parseFloat(document.getElementById('print-card-h')?.value) || 5.4;
    const previewScale = 2.2; 
    
    if (container.parentElement) {
        container.parentElement.style.alignItems = 'flex-start';
        container.parentElement.style.justifyContent = 'center';
    }

    container.onclick = (e) => {
        if (e.target === container) selectPrintCard(-1);
    };

    container.style.width = (pW * previewScale) + 'px'; 
    container.style.minHeight = (pH * previewScale) + 'px'; 
    container.style.padding = (margin * previewScale) + 'px'; 
    container.style.gap = (spacing * previewScale) + 'px';
    container.style.backgroundColor = '#ffffff';
    container.style.display = 'grid';
    container.style.boxSizing = 'border-box';
    container.style.margin = 'auto';

    if (useCmSizeMode) {
        container.style.gridTemplateColumns = `repeat(${cols}, auto)`;
        container.style.gridAutoRows = `auto`;
        container.style.justifyContent = 'center';
        container.style.alignContent = 'start';
        container.style.placeItems = 'center';
    } else {
        const innerW = Math.max(10, pW - margin * 2);
        const innerH = Math.max(10, pH - margin * 2);
        const cellW = Math.max(10, (innerW - spacing * (cols - 1)) / cols) * previewScale;
        const cellH = Math.max(10, (innerH - spacing * (rows - 1)) / rows) * previewScale;
        container.style.gridTemplateColumns = `repeat(${cols}, ${cellW}px)`;
        container.style.gridAutoRows = `${cellH}px`;
        container.style.justifyContent = 'center';
        container.style.alignContent = 'start';
    }

    const elementsToInsert = [];
    for (let i = 0; i < project.pages.length; i++) {
        if (currentToken !== previewRenderToken) return;

        const page = project.pages[i];
        const cardW = Number(page.customW_cm) || defaultW_cm;
        const cardH = Number(page.customH_cm) || defaultH_cm;
        const isSelected = (selectedPrintCardIndex === i);

        const div = document.createElement('div'); 
        if (useCmSizeMode) {
            div.style.width = ((cardW * 10) * previewScale) + 'px';
            div.style.height = ((cardH * 10) * previewScale) + 'px';
        } else {
            div.style.width = '100%'; 
            div.style.height = '100%'; 
        }

        div.className = `relative flex items-center justify-center overflow-hidden bg-white cursor-grab active:cursor-grabbing transition-shadow group ${isSelected ? 'ring-4 ring-blue-500 shadow-xl z-20' : 'border border-gray-300 shadow-sm hover:border-blue-400'}`;
        div.draggable = true;
        div.dataset.index = i;

        div.addEventListener('click', (e) => {
            e.stopPropagation();
            selectPrintCard(i);
        });

        const badge = document.createElement('span');
        badge.className = `absolute top-1 right-1 ${isSelected ? 'bg-blue-600 text-white opacity-100' : 'bg-slate-900/80 text-white opacity-70 group-hover:opacity-100'} text-[10px] font-bold px-1.5 py-0.5 rounded pointer-events-none transition z-10 dir-ltr`;
        badge.textContent = `#${i + 1} (${cardW}×${cardH} cm)`;
        div.appendChild(badge);

        if (useCmSizeMode) {
            const resizeHandle = document.createElement('div');
            resizeHandle.className = `absolute bottom-0 left-0 w-5 h-5 bg-blue-600 text-white flex items-center justify-center cursor-nwse-resize z-30 rounded-tr-md shadow ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`;
            resizeHandle.innerHTML = `<i class="fa-solid fa-up-right-and-down-left-from-center text-[10px]"></i>`;
            
            resizeHandle.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                div.draggable = false; 
                selectedPrintCardIndex = i;
                updateSelectionBannerUI();

                const startX = e.clientX;
                const startY = e.clientY;
                const startW = cardW;
                const startH = cardH;

                const onPointerMove = (moveEvent) => {
                    const dx = (startX - moveEvent.clientX) / (10 * previewScale); 
                    const dy = (moveEvent.clientY - startY) / (10 * previewScale);
                    const newW = Math.max(2.0, Math.min(20.0, Math.round((startW + dx) * 10) / 10));
                    const newH = Math.max(2.0, Math.min(28.0, Math.round((startH + dy) * 10) / 10));

                    page.customW_cm = newW;
                    page.customH_cm = newH;
                    div.style.width = ((newW * 10) * previewScale) + 'px';
                    div.style.height = ((newH * 10) * previewScale) + 'px';
                    badge.textContent = `#${i + 1} (${newW}×${newH} cm)`;

                    const wInput = document.getElementById('print-card-w');
                    const hInput = document.getElementById('print-card-h');
                    if (wInput) wInput.value = newW;
                    if (hInput) hInput.value = newH;
                };

                const onPointerUp = () => {
                    div.draggable = true;
                    window.removeEventListener('pointermove', onPointerMove);
                    window.removeEventListener('pointerup', onPointerUp);
                    generatePrintPreview();
                };

                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', onPointerUp);
            });
            div.appendChild(resizeHandle);
        }

        div.addEventListener('dragstart', (e) => {
            printDragStartIndex = i;
            div.style.opacity = '0.4';
            e.dataTransfer.effectAllowed = 'move';
        });
        div.addEventListener('dragend', () => {
            div.style.opacity = '1';
            printDragStartIndex = -1;
            container.querySelectorAll('div[data-index]').forEach(el => {
                el.style.outline = 'none';
                el.style.transform = 'scale(1)';
            });
        });
        div.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (printDragStartIndex !== -1 && printDragStartIndex !== i) {
                div.style.outline = '3px dashed #10b981';
                div.style.transform = 'scale(0.97)';
            }
        });
        div.addEventListener('dragleave', () => {
            div.style.outline = 'none';
            div.style.transform = 'scale(1)';
        });
        div.addEventListener('drop', (e) => {
            e.preventDefault();
            if (printDragStartIndex !== -1 && printDragStartIndex !== i) {
                const temp = project.pages[printDragStartIndex];
                project.pages[printDragStartIndex] = project.pages[i];
                project.pages[i] = temp;
                if (project.currentIndex === printDragStartIndex) project.currentIndex = i;
                else if (project.currentIndex === i) project.currentIndex = printDragStartIndex;
                if (selectedPrintCardIndex === printDragStartIndex) selectedPrintCardIndex = i;
                else if (selectedPrintCardIndex === i) selectedPrintCardIndex = printDragStartIndex;
                printDragStartIndex = -1;
                renderThumbnails();
                updateSelectionBannerUI();
                generatePrintPreview();
                autoSaveSession();
            }
        });

        const img = document.createElement('img'); 
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        try { 
            const processed = await getProcessedCanvas(page); 
            if (currentToken !== previewRenderToken) return;
            img.src = processed.toDataURL('image/jpeg', 0.92); 
        } catch (e) { 
            img.src = imageSource(page); 
        }
        div.appendChild(img); 
        elementsToInsert.push(div);
    }

    if (currentToken !== previewRenderToken) return;
    container.innerHTML = '';
    elementsToInsert.forEach(el => container.appendChild(el));
}

// ==================== نظام الإرسال المباشر للإيميل (مشفر ومؤمن) ====================

async function loadEmails(selectedEmail = '') {
    const select = document.getElementById('email-department');
    if (!select) return;
    let emails = [];
    try {
        emails = await window.api.getRecipients();
    } catch {
        emails = [];
    }
    select.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '-- اختر الشعبة / الجهة --';
    select.appendChild(defaultOpt);

    emails.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.email;
        opt.textContent = `🏢 ${e.name} (${e.email})`;
        select.appendChild(opt);
    });

    if (selectedEmail) select.value = selectedEmail;
}

window.openAddDepartmentModal = function() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
    const box = document.createElement('div');
    box.className = 'bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-6 w-96';
    box.innerHTML = `
        <h3 class="text-white text-base mb-4 font-bold flex items-center gap-2"><i class="fa-solid fa-building-user text-teal-400"></i> إضافة شعبة  </h3>
        <div class="mb-4">
            <label class="block text-slate-300 text-xs mb-1.5">اسم الشعبة أو القسم:</label>
            <input type="text" id="dept-name" placeholder="اسم شعبة التسجيل" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
        </div>
        <div class="mb-6">
            <label class="block text-slate-300 text-xs mb-1.5">البريد الإلكتروني للجهة:</label>
            <input type="email" id="dept-email" placeholder="example@gmail.com" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm text-left outline-none focus:border-teal-500" dir="ltr">
        </div>
        <div id="dept-err" class="text-red-400 text-xs mb-3 hidden"></div>
        <div class="flex justify-end gap-2">
            <button type="button" id="btn-dept-cancel" class="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg transition text-xs cursor-pointer">إلغاء</button>
            <button type="button" id="btn-dept-save" class="bg-teal-600 hover:bg-teal-500 text-white px-5 py-2 rounded-lg transition font-bold text-xs cursor-pointer">حفظ الإضافة</button>
        </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const nameInput = document.getElementById('dept-name');
    setTimeout(() => nameInput.focus(), 80);

    document.getElementById('btn-dept-cancel').onclick = () => document.body.removeChild(overlay);
    document.getElementById('btn-dept-save').onclick = async () => {
        const name = nameInput.value.trim();
        const email = document.getElementById('dept-email').value.trim();
        const errBox = document.getElementById('dept-err');
        if (!name || !email || !email.includes('@')) {
            errBox.textContent = '⚠️ يرجى إدخال اسم الشعبة وإيميل صحيح.';
            errBox.classList.remove('hidden');
            return;
        }
        const current = await window.api.getRecipients();
        current.push({ name, email });
        await window.api.saveRecipients(current);
        await loadEmails(email);
        document.body.removeChild(overlay);
        setStatus(`تمت إضافة «${name}» بنجاح.`);
    };
};

window.addEventListener('DOMContentLoaded', () => {
    loadEmails();
});

window.configureSender = async function() {
    let cfg = { senderName: '', email: '', hasPassword: false };
    try {
        cfg = await window.api.getMailConfig();
    } catch {}

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
    
    const box = document.createElement('div');
    box.className = 'bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-6 w-[430px] max-w-[92%]';
    box.innerHTML = `
        <h3 class="text-white text-base mb-4 font-bold flex items-center gap-2"><i class="fa-solid fa-gear text-teal-400"></i> إعدادات حساب المُرسل</h3>
        <div class="mb-3">
            <label class="block text-slate-300 text-xs mb-1.5">اسم المُرسل الظاهر بالرسالة (اختياري):</label>
            <input type="text" id="cfg-name" placeholder="مثال: شعبة الأرشيف / مكتب النور" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
        </div>
        <div class="mb-3">
            <label class="block text-slate-300 text-xs mb-1.5">إيميل المُرسل (Gmail / Outlook):</label>
            <input type="email" id="cfg-email" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm text-left outline-none focus:border-teal-500" dir="ltr">
        </div>
        <div class="mb-4">
            <label class="block text-slate-300 text-xs mb-1.5">كلمة مرور التطبيقات (App Password - 16 حرفاً):</label>
            <input type="password" id="cfg-pass" placeholder="${cfg.hasPassword ? '•••••••••••• (محفوظة - اتركها فارغة للإبقاء عليها)' : 'أدخل 16 حرفاً بدون مسافات'}" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm text-left outline-none focus:border-teal-500" dir="ltr">
            <div class="text-[11px] text-slate-400 mt-1.5">🔒 تُحفظ كلمة المرور مشفرة داخل نظام حماية الويندوز.</div>
        </div>
        <div id="cfg-msg" class="text-xs mb-3 hidden p-2 rounded"></div>
        <div class="flex justify-end gap-2">
            <button type="button" id="btn-cfg-cancel" class="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg transition text-xs cursor-pointer">إغلاق</button>
            <button type="button" id="btn-cfg-save" class="bg-teal-600 hover:bg-teal-500 text-white px-5 py-2 rounded-lg transition font-bold text-xs cursor-pointer">فحص وحفظ</button>
        </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const nameInput = document.getElementById('cfg-name');
    const emailInput = document.getElementById('cfg-email');
    const passInput = document.getElementById('cfg-pass');
    const msgBox = document.getElementById('cfg-msg');

    nameInput.value = cfg.senderName || '';
    emailInput.value = cfg.email || '';

    setTimeout(() => nameInput.focus(), 80);

    document.getElementById('btn-cfg-cancel').onclick = () => document.body.removeChild(overlay);
    document.getElementById('btn-cfg-save').onclick = async () => {
        const sName = nameInput.value.trim();
        const e = emailInput.value.trim();
        const p = passInput.value.trim();
        if (!e || (!p && !cfg.hasPassword)) {
            msgBox.className = 'text-xs mb-3 p-2 rounded bg-red-900/50 text-red-200 border border-red-700';
            msgBox.textContent = '⚠️ يرجى إدخال الإيميل وكلمة مرور التطبيقات.';
            return;
        }
        const saveBtn = document.getElementById('btn-cfg-save');
        saveBtn.disabled = true;
        saveBtn.textContent = 'جاري الفحص...';
        try {
            await window.api.saveMailConfig({ senderName: sName, email: e, password: p });
            setStatus('✅ تم التحقق من الحساب وحفظ الإعدادات بنجاح.');
            document.body.removeChild(overlay);
        } catch (err) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'فحص وحفظ';
            msgBox.className = 'text-xs mb-3 p-2 rounded bg-red-900/50 text-red-200 border border-red-700';
            msgBox.textContent = '❌ فشل التحقق: تأكد من الإنترنت ومن رمز الـ 16 حرفاً.';
        }
    };
};

window.sendDirectEmail = async function() {
    const select = document.getElementById('email-department');
    const toEmail = select.value;
    const deptName = select.options[select.selectedIndex]?.text || toEmail;
    const format = document.getElementById('email-format').value; 

    if (!toEmail) return setStatus('⚠️ يرجى اختيار الشعبة المستلمة أولاً من القائمة.');
    if (project.pages.length === 0) return setStatus('⚠️ لا توجد صفحات حالياً لإرسالها.');

    if (!confirm(`هل أنت متأكد من إرسال (${project.pages.length}) صفحة بصيغة (${format.toUpperCase()}) إلى:\n${deptName}؟`)) {
        return;
    }

    setStatus('⏳ جاري تجهيز الملفات وإرسال الإيميل...');
    try {
        const projName = document.getElementById('current-project-name')?.textContent?.trim() || 'مستندات مرفقة';
        let payload = { 
            to: toEmail, 
            format: format, 
            subject: projName === 'مشروع جديد' ? 'مستندات رسمية مرفقة' : `مستندات: ${projName}`
        };
        
        if (format === 'pdf') {
            const { jsPDF } = window.jspdf; 
            const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
            for (let i = 0; i < project.pages.length; i++) {
                const canvas = await getProcessedCanvas(project.pages[i]);
                const imgData = canvas.toDataURL('image/jpeg', 0.95);
                const ratio = Math.min(210 / canvas.width, 297 / canvas.height);
                const w = canvas.width * ratio, h = canvas.height * ratio, x = (210 - w) / 2, y = (297 - h) / 2;
                if (i > 0) doc.addPage();
                doc.addImage(imgData, 'JPEG', x, y, w, h);
            }
            payload.fileData = doc.output('datauristring');
            payload.fileName = `Scanned_Document_${Date.now()}.pdf`;
        } else {
            payload.fileData = [];
            for (let i = 0; i < project.pages.length; i++) {
                const canvas = await getProcessedCanvas(project.pages[i]);
                payload.fileData.push(canvas.toDataURL('image/jpeg', 0.92));
            }
        }

        const result = await window.api.sendDirectEmail(payload);
        if (result) {
            setStatus(`✅ تم إرسال المستندات بنجاح إلى ${deptName}!`);
        }
    } catch (e) {
        setStatus('❌ فشل الإرسال: ' + e.message.replace('Error: ', ''));
    }
};

window.onload = init;

// ==================== نظام النوافذ العربية الاحترافية الموحد (بديل نوافذ الويندوز) ====================

// 1. استبدال كل رسائل التنبيه البيضاء (alert) بنافذة عربية داكنة
window.alert = function(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
        const box = document.createElement('div');
        box.className = 'bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-6 w-[380px] max-w-[92%] text-right';
        box.innerHTML = `
            <h3 class="text-white text-base mb-3 font-bold flex items-center gap-2">
                <i class="fa-solid fa-bell text-amber-400"></i> تنبيه النظام
            </h3>
            <p class="text-slate-200 text-sm mb-6 leading-relaxed bg-slate-900/80 p-3.5 rounded-lg border border-slate-700">${String(message || '').replace(/\n/g, '<br>')}</p>
            <div class="flex justify-end">
                <button type="button" id="custom-alert-ok" class="bg-teal-600 hover:bg-teal-500 text-white px-6 py-2 rounded-lg transition font-bold text-xs cursor-pointer">حسناً، فهمت</button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const okBtn = box.querySelector('#custom-alert-ok');
        setTimeout(() => okBtn.focus(), 50);
        okBtn.onclick = () => {
            document.body.removeChild(overlay);
            resolve(true);
        };
    });
};

// 2. دالة تأكيد عربية احترافية لكل العمليات (حذف، مسح، مشروع جديد)
window.showArabicConfirm = function(title, message, confirmText = 'نعم، تأكيد', isDanger = false) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
        const box = document.createElement('div');
        box.className = 'bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-6 w-[400px] max-w-[92%] text-right';
        const btnColor = isDanger ? 'bg-red-600 hover:bg-red-500' : 'bg-teal-600 hover:bg-teal-500';
        const iconHtml = isDanger ? '<i class="fa-solid fa-triangle-exclamation text-red-400"></i>' : '<i class="fa-solid fa-circle-question text-teal-400"></i>';
        box.innerHTML = `
            <h3 class="text-white text-base mb-3 font-bold flex items-center gap-2">
                ${iconHtml} ${title}
            </h3>
            <div class="text-slate-200 text-sm mb-6 leading-relaxed bg-slate-900/80 p-3.5 rounded-lg border border-slate-700">${message}</div>
            <div class="flex justify-end gap-2">
                <button type="button" id="custom-conf-no" class="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg transition text-xs cursor-pointer">إلغاء الأمر</button>
                <button type="button" id="custom-conf-yes" class="${btnColor} text-white px-5 py-2 rounded-lg transition font-bold text-xs cursor-pointer">${confirmText}</button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        box.querySelector('#custom-conf-no').onclick = () => { document.body.removeChild(overlay); resolve(false); };
        box.querySelector('#custom-conf-yes').onclick = () => { document.body.removeChild(overlay); resolve(true); };
    });
};

// 3. دالة إدخال نصوص عربية احترافية (لتسمية المشروع)
window.showArabicPrompt = function(title, label, defaultValue = '') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
        const box = document.createElement('div');
        box.className = 'bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-6 w-[400px] max-w-[92%] text-right';
        box.innerHTML = `
            <h3 class="text-white text-base mb-4 font-bold flex items-center gap-2">
                <i class="fa-solid fa-pen-to-square text-teal-400"></i> ${title}
            </h3>
            <div class="mb-5">
                <label class="block text-slate-300 text-xs mb-2">${label}</label>
                <input type="text" id="custom-prompt-input" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
            </div>
            <div class="flex justify-end gap-2">
                <button type="button" id="custom-prm-no" class="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg transition text-xs cursor-pointer">إلغاء الأمر</button>
                <button type="button" id="custom-prm-yes" class="bg-teal-600 hover:bg-teal-500 text-white px-5 py-2 rounded-lg transition font-bold text-xs cursor-pointer">حفظ وتأكيد</button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const inp = box.querySelector('#custom-prompt-input');
        inp.value = defaultValue;
        setTimeout(() => { inp.focus(); inp.select(); }, 80);

        const submit = () => {
            const val = inp.value.trim();
            document.body.removeChild(overlay);
            resolve(val || null);
        };
        inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { document.body.removeChild(overlay); resolve(null); } };
        box.querySelector('#custom-prm-no').onclick = () => { document.body.removeChild(overlay); resolve(null); };
        box.querySelector('#custom-prm-yes').onclick = submit;
    });
};

// 4. ربط جميع أزرار البرنامج بالنوافذ العربية الاحترافية تلقائياً
// 4. ربط الأزرار بالدوال الأصلية مع نافذة تأكيد عربية
const _origDeletePage = window.deleteCurrentPage;
window.deleteCurrentPage = async function() {
    if (!project.pages || project.pages.length === 0) return;
    const ok = await window.showArabicConfirm('حذف الصفحة', 'هل أنت متأكد من حذف الصفحة المحددة نهائياً؟', 'نعم، حذف الصفحة', true);
    if (!ok) return;
    const oldConfirm = window.confirm;
    window.confirm = () => true;
    try {
        if (typeof _origDeletePage === 'function') await _origDeletePage();
        else if (typeof deleteCurrentPage === 'function') await deleteCurrentPage();
    } finally {
        window.confirm = oldConfirm;
    }
};

const _origClearAll = window.clearAllPages;
window.clearAllPages = async function() {
    if (!project.pages || project.pages.length === 0) return;
    const ok = await window.showArabicConfirm('مسح جميع الصفحات', `هل أنت متأكد من مسح كافة الصفحات الحالية (${project.pages.length} صفحة)؟`, 'نعم، مسح الكل', true);
    if (!ok) return;
    const oldConfirm = window.confirm;
    window.confirm = () => true;
    try {
        if (typeof _origClearAll === 'function') await _origClearAll();
        else if (typeof clearAllPages === 'function') await clearAllPages();
    } finally {
        window.confirm = oldConfirm;
    }
};

const _origResetPage = window.resetCurrentPage;
window.resetCurrentPage = async function() {
    if (!project.pages || project.pages.length === 0) return;
    const ok = await window.showArabicConfirm('إعادة ضبط الصفحة', 'هل تريد إلغاء كافة التعديلات والقص والعودة للصورة الأصلية؟', 'نعم، إعادة ضبط', false);
    if (!ok) return;
    const oldConfirm = window.confirm;
    window.confirm = () => true;
    try {
        if (typeof _origResetPage === 'function') await _origResetPage();
        else if (typeof resetCurrentPage === 'function') await resetCurrentPage();
    } finally {
        window.confirm = oldConfirm;
    }
};

const _origDeleteProject = window.deleteCurrentProject;
window.deleteCurrentProject = async function() {
    const ok = await window.showArabicConfirm('حذف المشروع الحالي', `هل أنت متأكد من حذف المشروع «${project.name || 'الحالي'}»؟`, 'نعم، حذف المشروع', true);
    if (!ok) return;
    const oldConfirm = window.confirm;
    window.confirm = () => true;
    try {
        if (typeof _origDeleteProject === 'function') await _origDeleteProject();
        else if (typeof deleteCurrentProject === 'function') await deleteCurrentProject();
    } finally {
        window.confirm = oldConfirm;
    }
};

// ==================== نظام بيانات الكتاب الرسمي (الصادرة والواردة) ====================

function getTodayDateString() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

window.updateDocHeaderInfo = function() {
    const nameEl = document.getElementById('current-project-name');
    const metaEl = document.getElementById('current-doc-meta');
    if (nameEl) nameEl.textContent = project.name || 'كتاب جديد';
    if (metaEl) {
        const parts = [];
        if (project.docNumber) parts.push(`العدد: ${project.docNumber}`);
        if (project.docDate) parts.push(`تاريخ الإرسال/الحفظ: ${project.docDate}`);
        if (project.senderDept) parts.push(`من: ${project.senderDept}`);
        if (project.receiverDept) parts.push(`إلى: ${project.receiverDept}`);
        metaEl.textContent = parts.length > 0 ? `( ${parts.join(' | ')} )` : '';
    }
};

// نافذة إدخال وتعديل بيانات الكتاب الرسمي (تفتح عند الضغط على "بيانات الكتاب" أو قبل الحفظ)
window.renameCurrentProject = function() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.78);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
        const box = document.createElement('div');
        box.className = 'bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-6 w-[460px] max-w-[94%] text-right';

        // جلب اسم الشعبة المستلمة المختارة حالياً كقيمة افتراضية إذا لم تكن مدخلة
        const selectDept = document.getElementById('email-department');
        let selectedReceiver = '';
        if (selectDept && selectDept.value) {
            selectedReceiver = (selectDept.options[selectDept.selectedIndex]?.text || '').replace('🏢', '').split('(')[0].trim();
        }

        const curName = (project.name && project.name !== 'مشروع جديد') ? project.name : '';
        const curNum = project.docNumber || '';
        const curDate = project.docDate || getTodayDateString();
        const curSender = project.senderDept || '';
        const curReceiver = project.receiverDept || selectedReceiver || '';

        box.innerHTML = `
            <h3 class="text-white text-base mb-4 font-bold flex items-center gap-2 border-b border-slate-700 pb-3">
                <i class="fa-solid fa-file-signature text-amber-400"></i> بيانات الكتاب الرسمي (للحفظ والإرسال)
            </h3>
            <div class="space-y-3 mb-5 text-xs">
                <div>
                    <label class="block text-slate-300 mb-1 font-semibold">اسم الكتاب / الموضوع:</label>
                    <input type="text" id="doc-inp-name" placeholder="مثال: كتاب تأييد استمرارية بالدوام" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-slate-300 mb-1 font-semibold">رقم الكتاب (العدد):</label>
                        <input type="text" id="doc-inp-num" placeholder="مثال: 1452 / أ" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
                    </div>
                    <div>
                        <label class="block text-slate-300 mb-1 font-semibold">تاريخ الإرسال / الخزن:</label>
                        <input type="date" id="doc-inp-date" class="w-full bg-slate-900 border border-slate-600 text-teal-400 font-mono rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-slate-300 mb-1 font-semibold">الجهة المرسلة:</label>
                        <input type="text" id="doc-inp-sender" placeholder="مثال: شعبة التسجيل" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
                    </div>
                    <div>
                        <label class="block text-slate-300 mb-1 font-semibold">الجهة المستلمة:</label>
                        <input type="text" id="doc-inp-receiver" placeholder="مثال: رئاسة الجامعة" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
                    </div>
                </div>
            </div>
            <div class="flex justify-end gap-2">
                <button type="button" id="doc-btn-cancel" class="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg transition text-xs cursor-pointer">إلغاء</button>
                <button type="button" id="doc-btn-save" class="bg-teal-600 hover:bg-teal-500 text-white px-6 py-2 rounded-lg transition font-bold text-xs cursor-pointer">حفظ وتثبيت البيانات</button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const inpName = box.querySelector('#doc-inp-name');
        const inpNum = box.querySelector('#doc-inp-num');
        const inpDate = box.querySelector('#doc-inp-date');
        const inpSender = box.querySelector('#doc-inp-sender');
        const inpReceiver = box.querySelector('#doc-inp-receiver');

        inpName.value = curName;
        inpNum.value = curNum;
        inpDate.value = curDate;
        inpSender.value = curSender;
        inpReceiver.value = curReceiver;

        setTimeout(() => inpName.focus(), 80);

        box.querySelector('#doc-btn-cancel').onclick = () => {
            document.body.removeChild(overlay);
            resolve(false);
        };
        box.querySelector('#doc-btn-save').onclick = () => {
            project.name = inpName.value.trim() || 'كتاب رسمي';
            project.docNumber = inpNum.value.trim();
            project.docDate = inpDate.value || getTodayDateString();
            project.senderDept = inpSender.value.trim();
            project.receiverDept = inpReceiver.value.trim();

            window.updateDocHeaderInfo();
            if (typeof saveDraft === 'function') saveDraft();
            document.body.removeChild(overlay);
            setStatus(`✅ تم تثبيت بيانات الكتاب «${project.name}» بنجاح.`);
            resolve(true);
        };
    });
};

// إذا ضغط المستخدم "حفظ المشروع" ولم يدخل بيانات الكتاب بعد، تفتح له النافذة تلقائياً بالبداية
const _origSaveProject = window.saveProject;
window.saveProject = async function() {
    if (!project.docDate || !project.name || project.name === 'مشروع جديد' || project.name === 'كتاب جديد') {
        const ok = await window.renameCurrentProject();
        if (!ok) return;
    }
    if (typeof _origSaveProject === 'function') await _origSaveProject();
};

// إرسال الإيميل مع كافة بيانات الكتاب وتسمية الملف المرفق باسم وتاريخ الكتاب
window.sendDirectEmail = async function() {
    const select = document.getElementById('email-department');
    const toEmail = select.value;
    const rawText = select.options[select.selectedIndex]?.text || toEmail;
    const cleanDeptName = rawText.replace('🏢', '').split('(')[0].trim() || toEmail;
    const format = document.getElementById('email-format').value;
    const formatArabic = format === 'pdf' ? 'ملف PDF موحد' : 'صور عالية الدقة';

    if (!toEmail) return setStatus('⚠️ يرجى اختيار الشعبة أو الجهة المستلمة أولاً من القائمة.');
    if (!project.pages || project.pages.length === 0) return setStatus('⚠️ لا توجد صفحات حالياً لإرسالها.');

    // إذا لم يتم ملء بيانات الكتاب بعد، نفتح نافذة البيانات أولاً لتثبيتها قبل الإرسال
    if (!project.docDate || !project.name || project.name === 'مشروع جديد' || project.name === 'كتاب جديد') {
        project.receiverDept = project.receiverDept || cleanDeptName;
        const filled = await window.renameCurrentProject();
        if (!filled) return;
    }

    // تحديث تاريخ الإرسال ليكون تاريخ اليوم الفعلي للإرسال
    const sendDate = project.docDate || getTodayDateString();
    const docTitle = project.name || 'كتاب رسمي';
    const docNum = project.docNumber || 'بدون رقم';
    const fromDept = project.senderDept || 'غير محدد';
    const toDept = project.receiverDept || cleanDeptName;

    const msgHtml = `
        <div class="space-y-1.5 text-xs">
            <div class="flex justify-between border-b border-slate-700 pb-1"><span class="text-slate-400">اسم الكتاب:</span><b class="text-white">${docTitle}</b></div>
            <div class="flex justify-between border-b border-slate-700 pb-1"><span class="text-slate-400">رقم وتاريخ الإرسال:</span><b class="text-amber-400">${docNum} (${sendDate})</b></div>
            <div class="flex justify-between border-b border-slate-700 pb-1"><span class="text-slate-400">من جهة:</span><b class="text-white">${fromDept}</b></div>
            <div class="flex justify-between border-b border-slate-700 pb-1"><span class="text-slate-400">إلى جهة:</span><b class="text-teal-400">${toDept} (${toEmail})</b></div>
            <div class="flex justify-between"><span class="text-slate-400">المرفقات:</span><b class="text-white">${project.pages.length} صفحة (${formatArabic})</b></div>
        </div>
    `;

    const ok = await window.showArabicConfirm('تأكيد إرسال الكتاب الرسمي', msgHtml, 'تأكيد وإرسال الآن', false);
    if (!ok) return;

    setStatus('⏳ جاري تجهيز الكتاب الرسمي وإرسال البريد الإلكتروني...');
    try {
        const emailSubject = `كتاب: ${docTitle}`;
        const emailBody = [
            `السلام عليكم ورحمة الله وبركاته،`,
            ``,
            `مرفق لكم طياً الكتاب الرسمي مع كافة تفاصيله للأرشفة والحفظ:`,
            `----------------------------------------`,
            `• اسم الكتاب / الموضوع : ${docTitle}`,
            `• رقم الكتاب (العدد) : ${docNum}`,
            `• تاريخ الإرسال : ${sendDate}`,
            `• الجهة المرسلة : ${fromDept}`,
            `• الجهة المستلمة : ${toDept}`,
            `• عدد الصفحات المرفقة : ${project.pages.length}`,
            `----------------------------------------`,
            `مع التقدير.`
        ].join('\n');

        const safeFileName = `${docTitle}_عدد_${docNum}_بتاريخ_${sendDate}`.replace(/[\\/:*?"<>|]/g, '-');

        let payload = { 
            to: toEmail, 
            format: format, 
            subject: emailSubject,
            bodyText: emailBody
        };
        
        if (format === 'pdf') {
            const { jsPDF } = window.jspdf; 
            const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
            for (let i = 0; i < project.pages.length; i++) {
                const canvas = await getProcessedCanvas(project.pages[i]);
                const imgData = canvas.toDataURL('image/jpeg', 0.95);
                const ratio = Math.min(210 / canvas.width, 297 / canvas.height);
                const w = canvas.width * ratio, h = canvas.height * ratio, x = (210 - w) / 2, y = (297 - h) / 2;
                if (i > 0) doc.addPage();
                doc.addImage(imgData, 'JPEG', x, y, w, h);
            }
            payload.fileData = doc.output('datauristring');
            payload.fileName = `${safeFileName}.pdf`;
        } else {
            payload.fileData = [];
            for (let i = 0; i < project.pages.length; i++) {
                const canvas = await getProcessedCanvas(project.pages[i]);
                payload.fileData.push(canvas.toDataURL('image/jpeg', 0.92));
            }
        }

        const result = await window.api.sendDirectEmail(payload);
        if (result) {
            setStatus(`✅ تم إرسال الكتاب «${docTitle}» بنجاح إلى «${toDept}»!`);
        }
    } catch (e) {
        setStatus('❌ فشل الإرسال: ' + e.message.replace('Error: ', ''));
    }
};

// ==================== ربط حفظ PDF وحفظ الصور ببيانات الكتاب وتسمية الملف تلقائياً ====================

function buildOfficialFileName() {
    const title = (project.name && project.name !== 'مشروع جديد' && project.name !== 'كتاب جديد') ? project.name : 'كتاب_رسمي';
    const parts = [title];
    if (project.docNumber) parts.push(`عدد_${project.docNumber}`);
    if (project.senderDept) parts.push(`من_${project.senderDept}`);
    if (project.receiverDept) parts.push(`إلى_${project.receiverDept}`);
    if (project.docDate) parts.push(`بتاريخ_${project.docDate}`);
    return parts.join('_').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_');
}

// تحديث دالة حفظ PDF لتطلب بيانات الكتاب وتحفظه بالاسم الرسمي الكامل
window.exportPDF = async function() {
    if (!project.pages || project.pages.length === 0) {
        return setStatus('⚠️ لا توجد صفحات حالياً لحفظها كملف PDF.');
    }

    // إذا لم يدخل المستخدم بيانات الكتاب بعد، نفتح له نافذة البيانات أولاً
    if (!project.docDate || !project.name || project.name === 'مشروع جديد' || project.name === 'كتاب جديد') {
        const ok = await window.renameCurrentProject();
        if (!ok) return;
    }

    setStatus('⏳ جاري تجهيز ملف الـ PDF الرسمي...');
    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        for (let i = 0; i < project.pages.length; i++) {
            const canvas = await getProcessedCanvas(project.pages[i]);
            const imgData = canvas.toDataURL('image/jpeg', 0.95);
            const ratio = Math.min(210 / canvas.width, 297 / canvas.height);
            const w = canvas.width * ratio, h = canvas.height * ratio;
            const x = (210 - w) / 2, y = (297 - h) / 2;
            if (i > 0) doc.addPage();
            doc.addImage(imgData, 'JPEG', x, y, w, h);
        }

        const officialName = `${buildOfficialFileName()}.pdf`;
        doc.save(officialName);
        setStatus(`✅ تم حفظ الملف باسم: ${officialName}`);
    } catch (e) {
        setStatus('❌ حدث خطأ أثناء حفظ PDF: ' + e.message);
    }
};

// تحديث دالة حفظ الصور لتطلب بيانات الكتاب وتحفظها بالاسم الرسمي الكامل
window.exportImages = async function() {
    if (!project.pages || project.pages.length === 0) {
        return setStatus('⚠️ لا توجد صفحات حالياً لحفظها كصور.');
    }

    if (!project.docDate || !project.name || project.name === 'مشروع جديد' || project.name === 'كتاب جديد') {
        const ok = await window.renameCurrentProject();
        if (!ok) return;
    }

    setStatus('⏳ جاري تصدير الصور بالاسم الرسمي...');
    try {
        const baseName = buildOfficialFileName();
        for (let i = 0; i < project.pages.length; i++) {
            const canvas = await getProcessedCanvas(project.pages[i]);
            const link = document.createElement('a');
            link.download = project.pages.length === 1 ? `${baseName}.jpg` : `${baseName}_صفحة_${i + 1}.jpg`;
            link.href = canvas.toDataURL('image/jpeg', 0.95);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
        setStatus(`✅ تم حفظ الصور باسم الكتاب الرسمي بنجاح.`);
    } catch (e) {
        setStatus('❌ حدث خطأ أثناء حفظ الصور: ' + e.message);
    }
};

// ==================== دوال تعديل وحذف الجهات المستلمة ====================

// 1. دالة حذف الشعبة أو الجهة المحددة من القائمة
window.deleteSelectedDepartment = async function() {
    const select = document.getElementById('email-department');
    const selectedEmail = select?.value;
    if (!selectedEmail) {
        return setStatus('⚠️ يرجى اختيار الجهة التي تريد حذفها من القائمة أولاً.');
    }

    const rawText = select.options[select.selectedIndex]?.text || selectedEmail;
    const cleanName = rawText.replace('🏢', '').split('(')[0].trim() || selectedEmail;

    const ok = await window.showArabicConfirm(
        'حذف جهة مستلمة',
        `هل أنت متأكد من حذف «<b>${cleanName}</b>» (<span dir="ltr" class="text-teal-400 font-mono">${selectedEmail}</span>) من قائمة الجهات؟`,
        'نعم، حذف الجهة',
        true
    );
    if (!ok) return;

    try {
        let current = await window.api.getRecipients();
        current = current.filter(item => item.email !== selectedEmail);
        await window.api.saveRecipients(current);
        await loadEmails('');
        setStatus(`🗑️ تم حذف «${cleanName}» من القائمة بنجاح.`);
    } catch (e) {
        setStatus('❌ تعذر حذف الجهة: ' + e.message);
    }
};

// 2. دالة تعديل اسم أو إيميل الجهة المحددة حالياً
window.editSelectedDepartment = async function() {
    const select = document.getElementById('email-department');
    const selectedEmail = select?.value;
    if (!selectedEmail) {
        return setStatus('⚠️ يرجى اختيار الجهة التي تريد تعديلها من القائمة أولاً.');
    }

    let current = [];
    try { current = await window.api.getRecipients(); } catch {}
    const targetIndex = current.findIndex(item => item.email === selectedEmail);
    if (targetIndex === -1) return;

    const oldData = current[targetIndex];

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
    const box = document.createElement('div');
    box.className = 'bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-6 w-96 text-right';
    box.innerHTML = `
        <h3 class="text-white text-base mb-4 font-bold flex items-center gap-2">
            <i class="fa-solid fa-pen-to-square text-amber-400"></i> تعديل بيانات الجهة
        </h3>
        <div class="mb-4">
            <label class="block text-slate-300 text-xs mb-1.5">اسم الشعبة أو القسم:</label>
            <input type="text" id="edit-dept-name" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm outline-none focus:border-teal-500">
        </div>
        <div class="mb-6">
            <label class="block text-slate-300 text-xs mb-1.5">البريد الإلكتروني للجهة:</label>
            <input type="email" id="edit-dept-email" class="w-full bg-slate-900 border border-slate-600 text-white rounded-lg p-2.5 text-sm text-left outline-none focus:border-teal-500" dir="ltr">
        </div>
        <div id="edit-dept-err" class="text-red-400 text-xs mb-3 hidden"></div>
        <div class="flex justify-end gap-2">
            <button type="button" id="btn-edit-cancel" class="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg transition text-xs cursor-pointer">إلغاء</button>
            <button type="button" id="btn-edit-save" class="bg-teal-600 hover:bg-teal-500 text-white px-5 py-2 rounded-lg transition font-bold text-xs cursor-pointer">حفظ التعديلات</button>
        </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const nameInp = box.querySelector('#edit-dept-name');
    const emailInp = box.querySelector('#edit-dept-email');
    const errBox = box.querySelector('#edit-dept-err');

    nameInp.value = oldData.name || '';
    emailInp.value = oldData.email || '';

    setTimeout(() => { nameInp.focus(); nameInp.select(); }, 80);

    box.querySelector('#btn-edit-cancel').onclick = () => document.body.removeChild(overlay);
    box.querySelector('#btn-edit-save').onclick = async () => {
        const newName = nameInp.value.trim();
        const newEmail = emailInp.value.trim();
        if (!newName || !newEmail || !newEmail.includes('@')) {
            errBox.textContent = '⚠️ يرجى إدخال اسم الشعبة وإيميل صحيح.';
            errBox.classList.remove('hidden');
            return;
        }
        current[targetIndex] = { name: newName, email: newEmail };
        await window.api.saveRecipients(current);
        await loadEmails(newEmail);
        document.body.removeChild(overlay);
        setStatus(`✅ تم تحديث بيانات «${newName}» بنجاح.`);
    };
};

// عرض اسم الشعبة فقط في القائمة المنسدلة لمنظر رسمي واحترافي
window.loadEmails = async function(selectedVal = '') {
    const select = document.getElementById('email-department');
    if (!select) return;
    let list = [];
    try { list = await window.api.getRecipients(); } catch {}
    select.innerHTML = '<option value="">-- اختر الشعبة / الجهة --</option>';
    list.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.email;
        opt.textContent = `🏢 ${item.name}`; // يظهر الاسم فقط بدون الإيميل
        select.appendChild(opt);
    });
    if (selectedVal) select.value = selectedVal;
};
window.loadEmails();

// ==================== لمسات احترافية للأرشفة والتعبئة التلقائية ====================

// 1. حفظ آخر "جهة مرسلة" تلقائياً حتى لا يضطر الموظف لكتابتها في كل مرة
const _baseRenameDoc = window.renameCurrentProject;
window.renameCurrentProject = async function() {
    // تعبئة تلقائية للجهة المرسلة من آخر كتاب إذا كانت فارغة
    if (!project.senderDept) {
        project.senderDept = localStorage.getItem('smart_scanner_last_sender') || '';
    }
    // تعبئة تلقائية للجهة المستلمة من القائمة المنسدلة إذا كان مختاراً لشعبة
    const selectDept = document.getElementById('email-department');
    if (selectDept && selectDept.value && !project.receiverDept) {
        project.receiverDept = (selectDept.options[selectDept.selectedIndex]?.text || '').replace('🏢', '').trim();
    }

    const res = await _baseRenameDoc();
    if (res && project.senderDept) {
        localStorage.setItem('smart_scanner_last_sender', project.senderDept);
    }
    return res;
};

// 2. إظهار تفاصيل الكتاب (العدد، التاريخ، من، إلى) داخل نافذة "فتح مشروع"
const _origOpenProjectModal = window.openProjectModal;
window.openProjectModal = async function() {
    if (typeof _origOpenProjectModal === 'function') await _origOpenProjectModal();
    
    // تحسين عرض بطاقات المشاريع المحفوظة لإظهار بيانات الصادرة والواردة
    const listEl = document.getElementById('projects-list');
    if (!listEl) return;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('smart_scanner_projects_v4') || '[]'); } catch {}
    
    const items = listEl.querySelectorAll('.flex.items-center.justify-between');
    items.forEach((row, idx) => {
        const p = saved[idx];
        if (!p) return;
        const details = [];
        if (p.docNumber) details.push(`العدد: <b>${p.docNumber}</b>`);
        if (p.docDate) details.push(`التاريخ: <b>${p.docDate}</b>`);
        if (p.senderDept) details.push(`المرسل: <b>${p.senderDept}</b>`);
        if (p.receiverDept) details.push(`المستلم: <b>${p.receiverDept}</b>`);
        
        if (details.length > 0 && !row.querySelector('.doc-archive-meta')) {
            const metaDiv = document.createElement('div');
            metaDiv.className = 'doc-archive-meta text-[11px] text-teal-400 mt-1 flex flex-wrap gap-2';
            metaDiv.innerHTML = details.join(' <span class="text-slate-600">|</span> ');
            const titleBlock = row.querySelector('div');
            if (titleBlock) titleBlock.appendChild(metaDiv);
        }
    });
};
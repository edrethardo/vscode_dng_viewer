import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { decodeDng } from './dngDecoder';

export function activate(context: vscode.ExtensionContext) {
	const tempFiles: string[] = [];
	const activeServers: http.Server[] = [];
	const decoderJs = fs.readFileSync(path.join(context.extensionPath, 'media', 'dng-decoder.js'), 'utf8');

	function closeAllServers() {
		for (const s of activeServers) {
			try { s.close(); } catch { /* ignore */ }
		}
		activeServers.length = 0;
	}

	function trackServer(server: http.Server) {
		activeServers.push(server);
	}

	/** Find all .dng files recursively in a directory. */
	function findDngFiles(dir: string): string[] {
		const dngs: string[] = [];
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				dngs.push(...findDngFiles(fullPath));
			} else if (entry.isFile() && /\.(dng|DNG)$/.test(entry.name)) {
				dngs.push(fullPath);
			}
		}
		return dngs;
	}

	// Single-file preview command
	context.subscriptions.push(
		vscode.commands.registerCommand('dngViewer.open', async (uri?: vscode.Uri) => {
			if (!uri) {
				const uris = await vscode.window.showOpenDialog({
					canSelectMany: false,
					filters: { 'DNG Files': ['dng', 'DNG'] },
				});
				if (!uris || uris.length === 0) { return; }
				uri = uris[0];
			}

			try {
				const result = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Decoding DNG...' },
					async () => {
						return await decodeDng(uri!.fsPath);
					}
				);

				// Close any previous preview server
				closeAllServers();

				const baseName = path.basename(uri.fsPath, path.extname(uri.fsPath));
				const jpegBuf = result.jpegBuffer;
				const metaJson = JSON.stringify(result.metadata, null, 2);
				const dngFilePath = uri.fsPath;

				// Serve an HTML page with the image + metadata
				const server = http.createServer((req, res) => {
					if (req.url === '/thumb.jpg') {
						res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(jpegBuf.length) });
						res.end(jpegBuf);
					} else if (req.url === '/raw.dng') {
						// Serve the raw DNG file for client-side decode
						const stat = fs.statSync(dngFilePath);
						res.writeHead(200, {
							'Content-Type': 'application/octet-stream',
							'Content-Length': String(stat.size),
							'Cache-Control': 'max-age=3600',
						});
						fs.createReadStream(dngFilePath).pipe(res);
					} else if (req.url === '/dng-decoder.js') {
						res.writeHead(200, { 'Content-Type': 'application/javascript' });
						res.end(decoderJs);
					} else {
						// Serve a simple HTML viewer
						const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${baseName} — DNG Preview</title>
<style>
	body { margin: 0; background: #1e1e1e; color: #ccc; font-family: system-ui; display: flex; flex-direction: column; height: 100vh; }
	.toolbar { padding: 8px 16px; background: #252526; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
	.toolbar button { background: #0e639c; color: #fff; border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; }
	.toolbar button:hover { background: #1177bb; }
	.toolbar .info { font-size: 13px; opacity: 0.7; }
	.zoom-display { font-size: 13px; opacity: 0.7; min-width: 60px; }
	.load-status { font-size: 12px; opacity: 0.7; color: #ccc; }
	.container { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: center; position: relative; cursor: grab; }
	.container.dragging { cursor: grabbing; }
	#image-wrapper { transform-origin: center; transition: transform 0.1s ease-out; position: relative; }
	.container img, .container canvas { display: block; object-fit: contain; opacity: 1; transition: opacity 0.3s; user-select: none; -webkit-user-drag: none; }
	.container img.loading { opacity: 0.7; }
	#full-canvas { position: absolute; top: 0; left: 0; display: none; }
	#progress-bar-container { position: fixed; top: 41px; left: 0; right: 0; height: 3px; background: #333; display: none; z-index: 10; }
	#progress-bar-container.visible { display: block; }
	#progress-bar { height: 100%; background: #0e639c; width: 0%; transition: width 0.15s; }
	.meta { display: none; position: fixed; right: 0; top: 40px; bottom: 0; width: 350px; background: #252526; border-left: 1px solid #333; overflow: auto; padding: 12px; font-size: 12px; }
	.meta.visible { display: block; }
	.meta pre { white-space: pre-wrap; word-break: break-all; }
</style></head><body>
<div class="toolbar">
	<span><strong>${baseName}.dng</strong></span>
	<span class="info">${result.width} × ${result.height}</span>
	<button onclick="zoomIn()">+</button>
	<button onclick="zoomOut()">−</button>
	<button onclick="resetZoom()">Reset</button>
	<span class="zoom-display" id="zoom-display">100%</span>
	<span class="load-status" id="load-status">Downloading raw file...</span>
	<button onclick="document.querySelector('.meta').classList.toggle('visible')">EXIF</button>
</div>
<div id="progress-bar-container"><div id="progress-bar"></div></div>
<div class="container"><div id="image-wrapper"><img id="main-image" src="/thumb.jpg" alt="${baseName}"><canvas id="full-canvas"></canvas></div></div>
<div class="meta"><pre>${metaJson.replace(/</g, '&lt;')}</pre></div>
<script src="/dng-decoder.js"></script>
<script>
	let zoomLevel = 1;
	const minZoom = 0.1;
	const maxZoom = 8;
	const mainImg = document.getElementById('main-image');

	let panX = 0, panY = 0;

	function updateZoom() {
		const wrapper = document.getElementById('image-wrapper');
		wrapper.style.transform = \`translate(\${panX}px, \${panY}px) scale(\${zoomLevel})\`;
		document.getElementById('zoom-display').textContent = Math.round(zoomLevel * 100) + '%';
	}

	function zoomIn() {
		zoomLevel = Math.min(maxZoom, zoomLevel * 1.2);
		updateZoom();
	}

	function zoomOut() {
		zoomLevel = Math.max(minZoom, zoomLevel / 1.2);
		updateZoom();
	}

	function resetZoom() {
		zoomLevel = 1;
		panX = 0; panY = 0;
		updateZoom();
	}

	// Drag-to-pan
	(function() {
		const container = document.querySelector('.container');
		let dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
		container.addEventListener('mousedown', function(e) {
			if (e.button !== 0) return;
			dragging = true; startX = e.clientX; startY = e.clientY;
			startPanX = panX; startPanY = panY;
			container.classList.add('dragging');
			e.preventDefault();
		});
		document.addEventListener('mousemove', function(e) {
			if (!dragging) return;
			panX = startPanX + (e.clientX - startX);
			panY = startPanY + (e.clientY - startY);
			updateZoom();
		});
		document.addEventListener('mouseup', function() {
			if (!dragging) return;
			dragging = false;
			container.classList.remove('dragging');
		});
	})();

	// Client-side decode: download raw DNG and decode in browser
	const progressBar = document.getElementById('progress-bar');
	const progressContainer = document.getElementById('progress-bar-container');
	const loadStatus = document.getElementById('load-status');
	const fullCanvas = document.getElementById('full-canvas');
	progressContainer.classList.add('visible');

	const xhr = new XMLHttpRequest();
	xhr.responseType = 'arraybuffer';
	xhr.addEventListener('progress', (e) => {
		if (e.lengthComputable) {
			progressBar.style.width = ((e.loaded / e.total) * 100) + '%';
			loadStatus.textContent = 'Downloading ' + Math.round(e.loaded/1048576) + '/' + Math.round(e.total/1048576) + ' MB';
		}
	});
	xhr.addEventListener('load', () => {
		loadStatus.textContent = 'Decoding...';
		progressBar.style.width = '100%';

		// Size canvas overlay to match the displayed thumbnail
		const rect = mainImg.getBoundingClientRect();
		fullCanvas.style.width = rect.width + 'px';
		fullCanvas.style.height = rect.height + 'px';
		fullCanvas.style.display = 'block';

		decodeDngToCanvas(xhr.response, fullCanvas,
			function(pct) {
				loadStatus.textContent = 'Rendering ' + Math.round(pct * 100) + '%';
			},
			function(err) {
				if (err) {
					loadStatus.textContent = 'Decode error: ' + err;
					fullCanvas.style.display = 'none';
					return;
				}
				loadStatus.textContent = '';
				setTimeout(function() { progressContainer.classList.remove('visible'); }, 300);
			}
		);
	});
	xhr.addEventListener('error', () => {
		loadStatus.textContent = 'Download failed';
		progressContainer.classList.remove('visible');
	});
	xhr.open('GET', '/raw.dng');
	xhr.send();

	document.addEventListener('wheel', (e) => {
		const container = document.querySelector('.container');
		if (e.target === container || container.contains(e.target)) {
			e.preventDefault();
			if (e.deltaY < 0) {
				zoomIn();
			} else {
				zoomOut();
			}
		}
	}, { passive: false });

	document.addEventListener('keydown', (e) => {
		if (e.key === '+' || e.key === '=') zoomIn();
		if (e.key === '-') zoomOut();
		if (e.key === '0') resetZoom();
	});
</script>
</body></html>`;
						res.writeHead(200, { 'Content-Type': 'text/html' });
						res.end(html);
					}
				});

				trackServer(server);

				await new Promise<void>((resolve, reject) => {
					server.listen(0, '127.0.0.1', async () => {
						try {
							const addr = server.address() as { port: number };
							const localUri = vscode.Uri.parse(`http://127.0.0.1:${addr.port}/`);
							const externalUri = await vscode.env.asExternalUri(localUri);
							await vscode.env.openExternal(externalUri);
							resolve();
						} catch (e) {
							reject(e);
						}
					});
					server.on('error', reject);
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`DNG Viewer: ${message}`);
			}
		})
	);

	// Folder preview command: browse all DNGs in a folder
	context.subscriptions.push(
		vscode.commands.registerCommand('dngViewer.previewFolder', async (uri?: vscode.Uri) => {
			let folderPath: string;

			if (uri) {
				folderPath = uri.fsPath;
				if (!fs.statSync(folderPath).isDirectory()) {
					folderPath = path.dirname(folderPath);
				}
			} else {
				const uris = await vscode.window.showOpenDialog({
					canSelectMany: false,
					canSelectFolders: true,
					canSelectFiles: false,
				});
				if (!uris || uris.length === 0) { return; }
				folderPath = uris[0].fsPath;
			}

			try {
				const dngFiles = findDngFiles(folderPath);
				if (dngFiles.length === 0) {
					vscode.window.showWarningMessage(`No DNG files found in ${path.basename(folderPath)}`);
					return;
				}

				closeAllServers();

				// Cache for decoded images
				const decodeCache = new Map<string, { jpeg: Buffer; width: number; height: number; metadata: unknown }>();

				// Serve folder index + individual preview endpoints
				const server = http.createServer(async (req, res) => {
					const url = new URL(`http://localhost${req.url}`);
					const filePath = url.searchParams.get('file');

					// Serve browser-side decoder
					if (req.url === '/dng-decoder.js') {
						res.writeHead(200, { 'Content-Type': 'application/javascript' });
						res.end(decoderJs);
						return;
					}

					// Streaming decode endpoint
					if (req.url === '/decode-all') {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});

						// Decode all files with concurrency limit (3 at a time)
						const concurrency = 3;
						const queue = [...dngFiles];
						let queueIdx = 0;
						let inProgress = 0;
						let completed = 0;
						let closed = false;

						const safeSend = (msg: string) => {
							if (closed) { return; }
							try { res.write(msg); } catch (e) { closed = true; }
						};

						const processNext = async () => {
							if (queueIdx >= queue.length || closed) { return; }
							inProgress++;
							const fPath = queue[queueIdx++];

							try {
								if (!decodeCache.has(fPath)) {
									const result = await decodeDng(fPath);
									decodeCache.set(fPath, {
										jpeg: result.jpegBuffer,
										width: result.width,
										height: result.height,
										metadata: result.metadata,
									});
								}
							} catch (e) {
								// Silently skip decode errors
							} finally {
								completed++;
								safeSend(`data: {"file":"${JSON.stringify(fPath).slice(1,-1)}","completed":${completed},"total":${dngFiles.length}}\n\n`);

								inProgress--;
								if (queueIdx < queue.length) {
									processNext();
								} else if (inProgress === 0 && !closed) {
									safeSend('data: {"done":true}\n\n');
									try { res.end(); } catch (e) { /* already closed */ }
								}
							}
						};

						// Start concurrency workers
						for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
							processNext();
						}

						req.on('close', () => {
							closed = true;
							try { res.end(); } catch (e) { /* already closed */ }
						});
						return;
					}

					if (filePath && decodeCache.has(filePath)) {
						const cached = decodeCache.get(filePath);
						if (url.searchParams.get('raw') === '1') {
							// Serve the raw DNG file for client-side decode
							try {
								const stat = fs.statSync(filePath);
								res.writeHead(200, {
									'Content-Type': 'application/octet-stream',
									'Content-Length': String(stat.size),
									'Cache-Control': 'max-age=3600',
								});
								fs.createReadStream(filePath).pipe(res);
							} catch (e) {
								res.writeHead(500, { 'Content-Type': 'text/plain' });
								res.end('File not found');
							}
						} else if (url.searchParams.get('thumb') === '1') {
							// Serve the preview-size cached image as thumbnail
							res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(cached!.jpeg.length) });
							res.end(cached!.jpeg);
						} else {
							const baseN = path.basename(filePath, '.dng').replace(/</g, '&lt;');
							const metaJson = JSON.stringify(cached!.metadata, null, 2);
							const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${baseN} — DNG Preview</title>
<style>
	body { margin: 0; background: #1e1e1e; color: #ccc; font-family: system-ui; display: flex; flex-direction: column; height: 100vh; }
	.toolbar { padding: 8px 16px; background: #252526; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
	.toolbar a, .toolbar button { background: #0e639c; color: #fff; border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; text-decoration: none; display: inline-block; }
	.toolbar a:hover, .toolbar button:hover { background: #1177bb; }
	.toolbar .info { font-size: 13px; opacity: 0.7; }
	.zoom-display { font-size: 13px; opacity: 0.7; min-width: 60px; }
	.load-status { font-size: 12px; opacity: 0.7; color: #ccc; }
	.container { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: center; position: relative; cursor: grab; }
	.container.dragging { cursor: grabbing; }
	#image-wrapper { transform-origin: center; transition: transform 0.1s ease-out; position: relative; }
	.container img, .container canvas { display: block; object-fit: contain; opacity: 1; transition: opacity 0.3s; user-select: none; -webkit-user-drag: none; }
	.container img.loading { opacity: 0.7; }
	#full-canvas { position: absolute; top: 0; left: 0; display: none; }
	#progress-bar-container { position: fixed; top: 41px; left: 0; right: 0; height: 3px; background: #333; display: none; z-index: 10; }
	#progress-bar-container.visible { display: block; }
	#progress-bar { height: 100%; background: #0e639c; width: 0%; transition: width 0.15s; }
	.meta { display: none; position: fixed; right: 0; top: 40px; bottom: 0; width: 350px; background: #252526; border-left: 1px solid #333; overflow: auto; padding: 12px; font-size: 12px; }
	.meta.visible { display: block; }
	.meta pre { white-space: pre-wrap; word-break: break-all; }
</style></head><body>
<div class="toolbar">
	<a href="/">← Back to folder</a>
	<span><strong>${baseN}.dng</strong></span>
	<span class="info">${cached!.width} × ${cached!.height}</span>
	<button onclick="zoomIn()">+</button>
	<button onclick="zoomOut()">−</button>
	<button onclick="resetZoom()">Reset</button>
	<span class="zoom-display" id="zoom-display">100%</span>
	<span class="load-status" id="load-status">Downloading raw file...</span>
	<button onclick="document.querySelector('.meta').classList.toggle('visible')">EXIF</button>
</div>
<div id="progress-bar-container"><div id="progress-bar"></div></div>
<div class="container"><div id="image-wrapper"><img id="main-image" src="?file=${encodeURIComponent(filePath)}&thumb=1" alt="${baseN}"><canvas id="full-canvas"></canvas></div></div>
<div class="meta"><pre>${metaJson.replace(/</g, '&lt;')}</pre></div>
<script src="/dng-decoder.js"></script>
<script>
	let zoomLevel = 1;
	const minZoom = 0.1;
	const maxZoom = 8;
	const mainImg = document.getElementById('main-image');
	let panX = 0, panY = 0;

	function updateZoom() {
		const wrapper = document.getElementById('image-wrapper');
		wrapper.style.transform = \`translate(\${panX}px, \${panY}px) scale(\${zoomLevel})\`;
		document.getElementById('zoom-display').textContent = Math.round(zoomLevel * 100) + '%';
	}

	function zoomIn() {
		zoomLevel = Math.min(maxZoom, zoomLevel * 1.2);
		updateZoom();
	}

	function zoomOut() {
		zoomLevel = Math.max(minZoom, zoomLevel / 1.2);
		updateZoom();
	}

	function resetZoom() {
		zoomLevel = 1;
		panX = 0; panY = 0;
		updateZoom();
	}

	// Drag-to-pan
	(function() {
		const container = document.querySelector('.container');
		let dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
		container.addEventListener('mousedown', function(e) {
			if (e.button !== 0) return;
			dragging = true; startX = e.clientX; startY = e.clientY;
			startPanX = panX; startPanY = panY;
			container.classList.add('dragging');
			e.preventDefault();
		});
		document.addEventListener('mousemove', function(e) {
			if (!dragging) return;
			panX = startPanX + (e.clientX - startX);
			panY = startPanY + (e.clientY - startY);
			updateZoom();
		});
		document.addEventListener('mouseup', function() {
			if (!dragging) return;
			dragging = false;
			container.classList.remove('dragging');
		});
	})();

	// Client-side decode: download raw DNG and decode in browser
	const progressBar = document.getElementById('progress-bar');
	const progressContainer = document.getElementById('progress-bar-container');
	const loadStatus = document.getElementById('load-status');
	const fullCanvas = document.getElementById('full-canvas');
	progressContainer.classList.add('visible');

	const xhr = new XMLHttpRequest();
	xhr.responseType = 'arraybuffer';
	xhr.addEventListener('progress', (e) => {
		if (e.lengthComputable) {
			progressBar.style.width = ((e.loaded / e.total) * 100) + '%';
			loadStatus.textContent = 'Downloading ' + Math.round(e.loaded/1048576) + '/' + Math.round(e.total/1048576) + ' MB';
		}
	});
	xhr.addEventListener('load', () => {
		loadStatus.textContent = 'Decoding...';
		progressBar.style.width = '100%';

		const rect = mainImg.getBoundingClientRect();
		fullCanvas.style.width = rect.width + 'px';
		fullCanvas.style.height = rect.height + 'px';
		fullCanvas.style.display = 'block';

		decodeDngToCanvas(xhr.response, fullCanvas,
			function(pct) {
				loadStatus.textContent = 'Rendering ' + Math.round(pct * 100) + '%';
			},
			function(err) {
				if (err) {
					loadStatus.textContent = 'Decode error: ' + err;
					fullCanvas.style.display = 'none';
					return;
				}
				loadStatus.textContent = '';
				setTimeout(function() { progressContainer.classList.remove('visible'); }, 300);
			}
		);
	});
	xhr.addEventListener('error', () => {
		loadStatus.textContent = 'Download failed';
		progressContainer.classList.remove('visible');
	});
	xhr.open('GET', '?file=${encodeURIComponent(filePath)}&raw=1');
	xhr.send();

	document.addEventListener('wheel', (e) => {
		const container = document.querySelector('.container');
		if (e.target === container || container.contains(e.target)) {
			e.preventDefault();
			if (e.deltaY < 0) {
				zoomIn();
			} else {
				zoomOut();
			}
		}
	}, { passive: false });

	document.addEventListener('keydown', (e) => {
		if (e.key === '+' || e.key === '=') zoomIn();
		if (e.key === '-') zoomOut();
		if (e.key === '0') resetZoom();
	});
</script>
</body></html>`;
							res.writeHead(200, { 'Content-Type': 'text/html' });
							res.end(html);
						}
						return;
					}

					if (filePath) {
						// Decode this file on-demand
						if (!decodeCache.has(filePath)) {
							try {
								const result = await decodeDng(filePath);
								decodeCache.set(filePath, {
									jpeg: result.jpegBuffer,
									width: result.width,
									height: result.height,
									metadata: result.metadata,
								});
								res.writeHead(302, { 'Location': `?file=${encodeURIComponent(filePath)}` });
								res.end();
								return;
							} catch (e) {
								const msg = e instanceof Error ? e.message : String(e);
								res.writeHead(500, { 'Content-Type': 'text/plain' });
								res.end(`Decode error: ${msg}`);
								return;
							}
						}
					}

					// Serve index
					const relPaths = dngFiles.map(f => ({ full: f, rel: path.relative(folderPath, f).replace(/\\/g, '/') }));
					const folderName = path.basename(folderPath).replace(/</g, '&lt;');
					const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${folderName} — DNG Folder Preview</title>
<style>
	body { margin: 0; background: #1e1e1e; color: #ccc; font-family: system-ui; padding: 16px; }
	h1 { margin: 0 0 8px 0; }
	.header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
	.header button { background: #0e639c; color: #fff; border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer; }
	.header button:hover { background: #1177bb; }
	.header button:disabled { background: #666; cursor: not-allowed; }
	.progress { font-size: 13px; opacity: 0.7; min-width: 100px; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
	.item { aspect-ratio: 1; background: #252526; border: 1px solid #333; border-radius: 4px; overflow: hidden; position: relative; }
	.item a { display: block; width: 100%; height: 100%; }
	.item a:hover { border-color: #0e639c; }
	.item img { width: 100%; height: 100%; object-fit: cover; }
	.item-label { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); color: #fff; padding: 4px 8px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.item-spinner { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 20px; height: 20px; border: 2px solid #666; border-top-color: #0e639c; border-radius: 50%; animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: translate(-50%, -50%) rotate(360deg); } }
	a { color: #0e639c; text-decoration: none; }
	a:hover { color: #1177bb; }
</style></head><body>
<h1>📁 ${folderName}</h1>
<div class="header">
	<span>${dngFiles.length} DNG file${dngFiles.length !== 1 ? 's' : ''}</span>
	<span id="progress" class="progress"></span>
</div>
<div class="grid" id="grid">
${relPaths.map((p, i) => `<div class="item" data-file="${JSON.stringify(p.full).slice(1,-1)}" data-idx="${i}">
	<a href="?file=${encodeURIComponent(p.full)}"><img data-src="?file=${encodeURIComponent(p.full)}&thumb=1" style="display:none"><div class="item-spinner"></div><span class="item-label">${path.basename(p.rel)}</span></a>
</div>`).join('')}
</div>
<script>
	function decodeAll() {
		const eventSource = new EventSource('/decode-all');

		eventSource.onmessage = (e) => {
			const data = JSON.parse(e.data);
			if (data.done) {
				eventSource.close();
				document.getElementById('progress').textContent = 'Done!';
				return;
			}

			const { file, completed, total } = data;
			document.getElementById('progress').textContent = \`\${completed}/\${total}\`;

			// Update thumbnail
			const item = document.querySelector(\`[data-file="\${file.replace(/"/g, '&quot;')}"]\`);
			if (item) {
				const img = item.querySelector('img');
				const spinner = item.querySelector('.item-spinner');
				if (img && !img.src) {
					img.src = img.getAttribute('data-src');
					img.style.display = 'block';
					spinner.style.display = 'none';
					img.onerror = () => { spinner.style.display = 'block'; img.style.display = 'none'; };
				}
			}
		};

		eventSource.onerror = () => {
			eventSource.close();
			document.getElementById('progress').textContent = 'Error — reload to retry';
		};
	}

	decodeAll();
</script>
</body></html>`;

					res.writeHead(200, { 'Content-Type': 'text/html' });
					res.end(html);
				});

				trackServer(server);

				await new Promise<void>((resolve, reject) => {
					server.listen(0, '127.0.0.1', async () => {
						try {
							const addr = server.address() as { port: number };
							const localUri = vscode.Uri.parse(`http://127.0.0.1:${addr.port}/`);
							const externalUri = await vscode.env.asExternalUri(localUri);
							await vscode.env.openExternal(externalUri);
							resolve();
						} catch (e) {
							reject(e);
						}
					});
					server.on('error', reject);
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`DNG Folder Preview: ${message}`);
			}
		})
	);
	context.subscriptions.push({
		dispose() {
			closeAllServers();
			for (const f of tempFiles) {
				try { fs.unlinkSync(f); } catch { /* ignore */ }
			}
		}
	});
}

export function deactivate() {}

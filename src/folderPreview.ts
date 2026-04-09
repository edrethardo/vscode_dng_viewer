import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeDng } from './dngDecoder';

interface FolderPreviewCacheEntry {
	jpeg: Buffer;
	width: number;
	height: number;
	metadata: Record<string, unknown>;
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

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
	return escapeHtml(text).replace(/"/g, '&quot;');
}

export function registerPreviewFolderCommand(): vscode.Disposable {
	let activeServer: http.Server | null = null;

	const command = vscode.commands.registerCommand('dngViewer.previewFolder', async (uri?: vscode.Uri) => {
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
			if (!uris || uris.length === 0) {
				return;
			}
			folderPath = uris[0].fsPath;
		}

		try {
			const dngFiles = findDngFiles(folderPath);
			if (dngFiles.length === 0) {
				vscode.window.showWarningMessage(`No DNG files found in ${path.basename(folderPath)}`);
				return;
			}

			if (activeServer) {
				activeServer.close();
				activeServer = null;
			}

			const decodeCache = new Map<string, FolderPreviewCacheEntry>();

			const server = http.createServer(async (req, res) => {
				const url = new URL(`http://localhost${req.url ?? '/'}`);
				const filePath = url.searchParams.get('file');

				if (req.url === '/decode-all') {
					res.writeHead(200, {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
					});

					const concurrency = 3;
					let queueIdx = 0;
					let inProgress = 0;
					let completed = 0;

					const processNext = async () => {
						if (queueIdx >= dngFiles.length) {
							return;
						}

						inProgress++;
						const currentFile = dngFiles[queueIdx++];

						try {
							if (!decodeCache.has(currentFile)) {
								const result = await decodeDng(currentFile);
								decodeCache.set(currentFile, {
									jpeg: result.jpegBuffer,
									width: result.width,
									height: result.height,
									metadata: result.metadata,
								});
							}
						} catch {
							// Keep the index usable even when individual decodes fail.
						}

						completed++;
						res.write(`data: ${JSON.stringify({ file: currentFile, completed, total: dngFiles.length })}\n\n`);

						inProgress--;
						if (queueIdx < dngFiles.length) {
							void processNext();
						} else if (inProgress === 0) {
							res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
							res.end();
						}
					};

					for (let i = 0; i < Math.min(concurrency, dngFiles.length); i++) {
						void processNext();
					}

					req.on('close', () => {
						if (!res.writableEnded) {
							res.end();
						}
					});
					return;
				}

				if (filePath && decodeCache.has(filePath)) {
					const cached = decodeCache.get(filePath)!;
					if (url.searchParams.get('image') === '1') {
						res.writeHead(200, {
							'Content-Type': 'image/jpeg',
							'Content-Length': String(cached.jpeg.length),
						});
						res.end(cached.jpeg);
					} else {
						const baseName = path.basename(filePath, path.extname(filePath));
						const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(baseName)} - DNG Preview</title>
<style>
	body { margin: 0; background: #1e1e1e; color: #ccc; font-family: system-ui; display: flex; flex-direction: column; height: 100vh; }
	.toolbar { padding: 8px 16px; background: #252526; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
	.toolbar a, .toolbar button { background: #0e639c; color: #fff; border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; text-decoration: none; display: inline-block; }
	.toolbar a:hover, .toolbar button:hover { background: #1177bb; }
	.toolbar .info { font-size: 13px; opacity: 0.7; }
	.container { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: center; }
	.container img { max-width: 100%; max-height: 100%; object-fit: contain; }
	.meta { display: none; position: fixed; right: 0; top: 40px; bottom: 0; width: 350px; background: #252526; border-left: 1px solid #333; overflow: auto; padding: 12px; font-size: 12px; }
	.meta.visible { display: block; }
	.meta pre { white-space: pre-wrap; word-break: break-all; }
</style></head><body>
<div class="toolbar">
	<a href="/">Back to folder</a>
	<span><strong>${escapeHtml(path.basename(filePath))}</strong></span>
	<span class="info">${cached.width} x ${cached.height}</span>
	<button onclick="document.querySelector('.meta').classList.toggle('visible')">EXIF</button>
</div>
<div class="container"><img src="?file=${encodeURIComponent(filePath)}&image=1" alt="${escapeAttr(baseName)}"></div>
<div class="meta"><pre>${escapeHtml(JSON.stringify(cached.metadata, null, 2))}</pre></div>
</body></html>`;
						res.writeHead(200, { 'Content-Type': 'text/html' });
						res.end(html);
					}
					return;
				}

				if (filePath) {
					try {
						const result = await decodeDng(filePath);
						decodeCache.set(filePath, {
							jpeg: result.jpegBuffer,
							width: result.width,
							height: result.height,
							metadata: result.metadata,
						});
						res.writeHead(302, { Location: `?file=${encodeURIComponent(filePath)}` });
						res.end();
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						res.writeHead(500, { 'Content-Type': 'text/plain' });
						res.end(`Decode error: ${message}`);
					}
					return;
				}

				const relPaths = dngFiles.map((fullPath) => ({
					full: fullPath,
					rel: path.relative(folderPath, fullPath).replace(/\\/g, '/'),
				}));
				const folderName = path.basename(folderPath);
				const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(folderName)} - DNG Folder Preview</title>
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
<h1>${escapeHtml(folderName)}</h1>
<div class="header">
	<span>${dngFiles.length} DNG file${dngFiles.length !== 1 ? 's' : ''}</span>
	<button id="decodeBtn" onclick="decodeAll()">Decode All Thumbnails</button>
	<span id="progress" class="progress"></span>
</div>
<div class="grid" id="grid">
${relPaths.map((entry) => `<div class="item" data-file="${escapeAttr(entry.full)}">
	<a href="?file=${encodeURIComponent(entry.full)}"><img data-src="?file=${encodeURIComponent(entry.full)}&image=1" style="display:none"><div class="item-spinner"></div><span class="item-label">${escapeHtml(path.basename(entry.rel))}</span></a>
</div>`).join('')}
</div>
<script>
	let decoding = false;

	function decodeAll() {
		if (decoding) { return; }
		decoding = true;
		document.getElementById('decodeBtn').disabled = true;

		const eventSource = new EventSource('/decode-all');
		eventSource.onmessage = (event) => {
			const data = JSON.parse(event.data);
			if (data.done) {
				eventSource.close();
				document.getElementById('decodeBtn').disabled = false;
				document.getElementById('progress').textContent = 'Done';
				decoding = false;
				return;
			}

			document.getElementById('progress').textContent = data.completed + '/' + data.total;

			const selector = '[data-file="' + CSS.escape(data.file) + '"]';
			const item = document.querySelector(selector);
			if (!item) { return; }

			const img = item.querySelector('img');
			const spinner = item.querySelector('.item-spinner');
			if (!img || !spinner || img.src) { return; }

			img.src = img.getAttribute('data-src');
			img.style.display = 'block';
			spinner.style.display = 'none';
			img.onerror = () => {
				spinner.style.display = 'block';
				img.style.display = 'none';
			};
		};

		eventSource.onerror = () => {
			eventSource.close();
			document.getElementById('decodeBtn').disabled = false;
			document.getElementById('progress').textContent = 'Error';
			decoding = false;
		};
	}
</script>
</body></html>`;

				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end(html);
			});

			activeServer = server;
			await new Promise<void>((resolve, reject) => {
				server.listen(0, '127.0.0.1', async () => {
					try {
						const addr = server.address() as { port: number };
						const localUri = vscode.Uri.parse(`http://127.0.0.1:${addr.port}/`);
						const externalUri = await vscode.env.asExternalUri(localUri);
						await vscode.env.openExternal(externalUri);
						resolve();
					} catch (error) {
						reject(error);
					}
				});
				server.on('error', reject);
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`DNG Folder Preview: ${message}`);
		}
	});

	return vscode.Disposable.from(command, new vscode.Disposable(() => {
		if (activeServer) {
			activeServer.close();
			activeServer = null;
		}
	}));
}

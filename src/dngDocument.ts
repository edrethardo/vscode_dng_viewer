import * as vscode from 'vscode';

export class DngDocument implements vscode.CustomDocument {
	public readonly uri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	/** Cached decoded JPEG as a data URI (preview). Set after first decode. */
	public jpegDataUri: string | undefined;
	/** Cached high-resolution JPEG as a data URI. Set when high-res decode completes. */
	public highResJpegDataUri: string | undefined;
	/** Cached metadata. */
	public metadata: Record<string, unknown> | undefined;
	/** Image width after decode. */
	public width: number | undefined;
	/** Image height after decode. */
	public height: number | undefined;

	constructor(uri: vscode.Uri) {
		this.uri = uri;
	}

	dispose(): void {
		this._disposables.forEach(d => d.dispose());
		this._disposables.length = 0;
	}
}


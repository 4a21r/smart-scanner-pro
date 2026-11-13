# Smart Scanner

Electron desktop shell with a safe IPC bridge to a Windows Image Acquisition
(WIA) scanner through Python.

## Windows setup

1. Install Node.js and Python 3 on the Windows computer.
2. From the workspace root, run `pnpm install`.
3. Install the Python scanner dependency with
   `py -3 -m pip install -r desktop/smart-scanner/requirements.txt`.
4. From `desktop/smart-scanner`, run `pnpm start`.

The scan button in the original interface should call
`window.scannerBridge.scanDocument()`. It resolves to `{ path, dataUrl }`;
use `dataUrl` with the existing page/image creation flow. The selected scanner
is provided by the Windows WIA device picker.

## Interface

`index.html` is the supplied single-file interface. Its original markup,
styling, and libraries are retained; only `simulateScanner()` was replaced to
call the Electron bridge and add the returned scan as a page.

## Notes

- Scanner hardware access runs on Windows. It cannot be exercised in this
  Linux development environment.
- Electron keeps `nodeIntegration` disabled, uses context isolation, and leaves
  web security enabled. The preload exposes only the scan operation.
- Scans are written to the operating system temporary directory under
  `smart-scanner`.

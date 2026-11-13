"use strict";

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require("electron");
const nodemailer = require("nodemailer");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { readFile, realpath, stat } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fileURLToPath } = require("node:url");

const SCAN_TIMEOUT_MS = 180_000;
const MAX_SCAN_BYTES = 150 * 1024 * 1024;
let scanInProgress = false;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });
}

function assertTrustedSender(event) {
  let senderPath = "";
  try {
    senderPath = event.senderFrame ? fileURLToPath(event.senderFrame.url) : "";
  } catch {
    senderPath = "";
  }
  if (senderPath !== path.join(__dirname, "index.html")) {
    throw new Error("Unauthorized IPC request.");
  }
}

function getScannerScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "scanner_bin", "scanner.exe")
    : path.join(__dirname, "scanner_bin", "scanner.exe");
}

async function cleanupTempDirectory() {
  try {
    const tempDir = path.join(os.tmpdir(), "smart-scanner");
    const files = await fs.readdir(tempDir);
    for (const f of files) {
      if (f.endsWith(".bmp") || f.endsWith(".jpg") || f.endsWith(".jpeg") || f.endsWith(".png")) {
        await fs.unlink(path.join(tempDir, f)).catch(() => {});
      }
    }
  } catch {}
}

function runScannerProcess(options = {}) {
  return new Promise((resolve, reject) => {
    const exePath = getScannerScriptPath();
    const deviceId = typeof options === "string" ? options : (options?.deviceId || "");
    const dpi = options?.dpi || 300;
    const duplex = options?.duplex !== false ? "duplex" : "simplex";

    const args = ["scan", deviceId, String(dpi), duplex];

    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SCAN_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start scanner: ${error.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error("انتهت مهلة السحب الضوئي لكثرة الأوراق أو توقف الجهاز."));
      if (code !== 0) return reject(new Error(stderr.trim() || `Scanner exited with code ${code}.`));

      try {
        const outputPaths = JSON.parse(stdout.trim());
        resolve(outputPaths);
      } catch {
        reject(new Error("Invalid output format from scanner."));
      }
    });
  });
}

function getScannersList() {
  return new Promise((resolve) => {
    const exePath = getScannerScriptPath();
    const child = spawn(exePath, ["list"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("close", (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve([]);
        }
      } else {
        resolve([]);
      }
    });
  });
}

async function scanDocument(options = {}) {
  if (scanInProgress) throw new Error("توجد عملية سحب قيد التنفيذ حالياً.");
  scanInProgress = true;
  try {
    const reportedPaths = await runScannerProcess(options);
    const tempDir = path.resolve(os.tmpdir(), "smart-scanner");
    await fs.mkdir(tempDir, { recursive: true });
    const expectedDirectory = await realpath(tempDir);

    const results = [];
    for (const reportedPath of reportedPaths) {
      const resolvedPath = await realpath(reportedPath);
      const relativePath = path.relative(expectedDirectory, resolvedPath);
      const ext = path.extname(resolvedPath).toLowerCase();

      if (
        !relativePath ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath) ||
        (ext !== ".bmp" && ext !== ".jpg" && ext !== ".jpeg")
      ) {
        throw new Error("Scanner returned file outside temp folder.");
      }

      const fileInfo = await stat(resolvedPath);
      if (!fileInfo.isFile() || fileInfo.size > MAX_SCAN_BYTES) {
        await fs.unlink(resolvedPath).catch(() => {});
        throw new Error("حجم الصورة المسحوبة كبير جداً.");
      }

      const image = await readFile(resolvedPath);
      const mime = ext === ".bmp" ? "image/bmp" : "image/jpeg";
      results.push({
        path: resolvedPath,
        dataUrl: `data:${mime};base64,${image.toString("base64")}`,
      });
      await fs.unlink(resolvedPath).catch(() => {});
    }
    return results;
  } finally {
    scanInProgress = false;
  }
}

async function processImportedImage(dataUrl) {
  const matches = String(dataUrl || "").match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) throw new Error("Invalid image data");
  const buffer = Buffer.from(matches[2], "base64");

  const tempDir = path.join(os.tmpdir(), "smart-scanner");
  await fs.mkdir(tempDir, { recursive: true });
  const tempInputPath = path.join(tempDir, `input-${Date.now()}.bmp`);
  await fs.writeFile(tempInputPath, buffer);

  return new Promise((resolve, reject) => {
    const exePath = getScannerScriptPath();
    const child = spawn(exePath, ["process", tempInputPath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.once("error", async (err) => {
      await fs.unlink(tempInputPath).catch(() => {});
      reject(err);
    });
    child.once("close", async (code) => {
      await fs.unlink(tempInputPath).catch(() => {});
      if (code !== 0) return reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      try {
        const reportedPaths = JSON.parse(stdout.trim());
        const results = [];
        for (const reportedPath of reportedPaths) {
          const ext = path.extname(reportedPath).toLowerCase();
          const mime = ext === ".bmp" ? "image/bmp" : "image/jpeg";
          const image = await fs.readFile(reportedPath);
          results.push({
            path: reportedPath,
            dataUrl: `data:${mime};base64,${image.toString("base64")}`,
          });
          await fs.unlink(reportedPath).catch(() => {});
        }
        resolve(results);
      } catch {
        reject(new Error("Invalid output format from processing."));
      }
    });
  });
}

async function detectImageCorners(dataUrl) {
  const matches = String(dataUrl || "").match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) throw new Error("Invalid image data");
  const buffer = Buffer.from(matches[2], "base64");

  const tempDir = path.join(os.tmpdir(), "smart-scanner");
  await fs.mkdir(tempDir, { recursive: true });
  const tempInputPath = path.join(tempDir, `corners-${Date.now()}.bmp`);
  await fs.writeFile(tempInputPath, buffer);

  return new Promise((resolve, reject) => {
    const exePath = getScannerScriptPath();
    const child = spawn(exePath, ["corners", tempInputPath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.once("error", async (err) => {
      await fs.unlink(tempInputPath).catch(() => {});
      reject(err);
    });
    child.once("close", async (code) => {
      await fs.unlink(tempInputPath).catch(() => {});
      if (code !== 0) return reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      try {
        const corners = JSON.parse(stdout.trim());
        resolve(corners);
      } catch {
        reject(new Error("Invalid corners format from Python."));
      }
    });
  });
}

function getMailConfigPath() {
  return path.join(app.getPath("userData"), "mail-config.json");
}

function getRecipientsPath() {
  return path.join(app.getPath("userData"), "recipients.json");
}

async function readMailConfig() {
  try {
    const raw = await fs.readFile(getMailConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    let password = "";
    if (parsed.encryptedPassword && safeStorage.isEncryptionAvailable()) {
      password = safeStorage.decryptString(Buffer.from(parsed.encryptedPassword, "base64"));
    } else if (parsed.plainPassword) {
      password = parsed.plainPassword;
    }
    return { 
      senderName: parsed.senderName || "", 
      email: parsed.email || "", 
      password, 
      hasPassword: !!password 
    };
  } catch {
    return { senderName: "", email: "", password: "", hasPassword: false };
  }
}

async function writeMailConfig(senderName, email, password) {
  const data = { 
    senderName: String(senderName || "").trim(),
    email: String(email || "").trim() 
  };
  if (safeStorage.isEncryptionAvailable()) {
    data.encryptedPassword = safeStorage.encryptString(String(password || "")).toString("base64");
  } else {
    data.plainPassword = String(password || "");
  }
  await fs.writeFile(getMailConfigPath(), JSON.stringify(data, null, 2), "utf-8");
}

async function readRecipients() {
  try {
    const raw = await fs.readFile(getRecipientsPath(), "utf-8");
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeRecipients(list) {
  const clean = (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item.name === "string" && typeof item.email === "string")
    .map((item) => ({
      name: item.name.trim().slice(0, 80),
      email: item.email.trim().slice(0, 120),
    }))
    .filter((item) => item.name && item.email.includes("@"));
  await fs.writeFile(getRecipientsPath(), JSON.stringify(clean, null, 2), "utf-8");
  return clean;
}

const SMTP_PRESETS = {
  "gmail.com": { service: "gmail" },
  "outlook.com": { host: "smtp.office365.com", port: 587, secure: false },
  "hotmail.com": { host: "smtp.office365.com", port: 587, secure: false },
  "live.com": { host: "smtp.office365.com", port: 587, secure: false },
};

function createTransporterForEmail(email, password) {
  const domain = String(email.split("@")[1] || "").toLowerCase();
  const preset = SMTP_PRESETS[domain] || { service: "gmail" };
  return nodemailer.createTransport({
    ...preset,
    auth: { user: email, pass: password },
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.loadFile("index.html");
}

ipcMain.handle("get-scanners", async (event) => {
  assertTrustedSender(event);
  return await getScannersList();
});

ipcMain.handle("scan-document", async (event, options) => {
  assertTrustedSender(event);
  return scanDocument(options);
});

ipcMain.handle("process-image", async (event, dataUrl) => {
  assertTrustedSender(event);
  return processImportedImage(dataUrl);
});

ipcMain.handle("detect-corners", async (event, dataUrl) => {
  assertTrustedSender(event);
  return detectImageCorners(dataUrl);
});

ipcMain.handle("save-file-dialog", async (event, fileData, defaultName, existingPath = null) => {
  assertTrustedSender(event);
  if (existingPath && typeof existingPath === "string" && existingPath.endsWith(".ssp")) {
    await fs.writeFile(existingPath, fileData, "utf-8");
    return existingPath;
  }
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "حفظ المشروع",
    defaultPath: defaultName || "مشروع_جديد.ssp",
    filters: [{ name: "Smart Scanner Project", extensions: ["ssp"] }],
  });
  if (!canceled && filePath) {
    await fs.writeFile(filePath, fileData, "utf-8");
    return filePath;
  }
  return null;
});

ipcMain.handle("open-file-dialog", async (event) => {
  assertTrustedSender(event);
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "فتح مشروع",
    properties: ["openFile"],
    filters: [{ name: "Smart Scanner Project", extensions: ["ssp"] }],
  });
  if (!canceled && filePaths.length > 0) {
    const data = await fs.readFile(filePaths[0], "utf-8");
    return { path: filePaths[0], data };
  }
  return null;
});

ipcMain.handle("trash-project-file", async (event, filePath) => {
  assertTrustedSender(event);
  if (filePath && typeof filePath === "string" && filePath.endsWith(".ssp")) {
    await shell.trashItem(filePath);
    return true;
  }
  return false;
});

ipcMain.handle("mail-get-config", async (event) => {
  assertTrustedSender(event);
  const cfg = await readMailConfig();
  return { senderName: cfg.senderName, email: cfg.email, hasPassword: cfg.hasPassword };
});

ipcMain.handle("mail-save-config", async (event, { senderName, email, password }) => {
  assertTrustedSender(event);
  const cleanName = String(senderName || "").trim();
  const cleanEmail = String(email || "").trim();
  const cleanPass = String(password || "").trim().replace(/\s+/g, "");
  
  const oldCfg = await readMailConfig();
  const finalPass = cleanPass || oldCfg.password;

  if (!cleanEmail || !finalPass) {
    throw new Error("يرجى إدخال الإيميل وكلمة مرور التطبيقات.");
  }
  const transporter = createTransporterForEmail(cleanEmail, finalPass);
  await transporter.verify();
  await writeMailConfig(cleanName, cleanEmail, finalPass);
  return { ok: true };
});

ipcMain.handle("mail-get-recipients", async (event) => {
  assertTrustedSender(event);
  return await readRecipients();
});

ipcMain.handle("mail-save-recipients", async (event, list) => {
  assertTrustedSender(event);
  return await writeRecipients(list);
});

ipcMain.handle("send-email-direct", async (event, { to, subject, format, fileData, fileName, bodyText }) => {  
  assertTrustedSender(event);
  const cfg = await readMailConfig();
  if (!cfg.email || !cfg.password) {
    throw new Error("يرجى إعداد حساب المُرسل أولاً من أيقونة الإعدادات (⚙️).");
  }

  const recipients = await readRecipients();
  const allowed = recipients.find((r) => r.email.toLowerCase() === String(to || "").toLowerCase());
  if (!allowed) {
    throw new Error("الجهة المحددة غير موجودة ضمن قائمة الأقسام المحفوظة.");
  }

  const transporter = createTransporterForEmail(cfg.email, cfg.password);
  const attachments = [];

  if (format === "pdf") {
    const base64Part = String(fileData || "").split("base64,")[1] || "";
    attachments.push({
      filename: fileName || `Scanned_${Date.now()}.pdf`,
      content: base64Part,
      encoding: "base64",
    });
  } else if (Array.isArray(fileData)) {
    fileData.forEach((imgBase64, index) => {
      const base64Part = String(imgBase64 || "").split("base64,")[1] || "";
      attachments.push({
        filename: `page_${index + 1}.jpg`,
        content: base64Part,
        encoding: "base64",
      });
    });
  }

const fromHeader = cfg.senderName 
    ? `"${cfg.senderName}" <${cfg.email}>` 
    : cfg.email;

  const senderTitle = cfg.senderName || cfg.email;

  const customBody = bodyText || `السلام عليكم،\n\nمرفق لكم المستندات المرسلة إلى (${allowed.name}) من قِبل (${senderTitle}).`;

  const htmlRightToLeft = `
    <div dir="rtl" style="direction: rtl; text-align: right; font-family: Arial, Tahoma, sans-serif; font-size: 15px; line-height: 1.8; color: #1e293b;">
      ${customBody.replace(/\n/g, "<br>")}
    </div>
  `;

  const info = await transporter.sendMail({
    from: fromHeader,
    to: allowed.email,
    subject: subject || `مستندات مرسلة إلى (${allowed.name})`,
    text: customBody,
    html: htmlRightToLeft,
    attachments,
  });

  return info.messageId;
});

app.whenReady().then(async () => {
  await cleanupTempDirectory();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.on("window-minimize", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.minimize();
});

ipcMain.on("window-maximize", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  }
});

ipcMain.on("window-close", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.close();
});
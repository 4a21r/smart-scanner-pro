"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
    minimizeApp: () => ipcRenderer.send("window-minimize"),
    maximizeApp: () => ipcRenderer.send("window-maximize"),
    closeApp: () => ipcRenderer.send("window-close"),

    getScanners: () => ipcRenderer.invoke("get-scanners"),
    scanDocument: (options) => ipcRenderer.invoke("scan-document", options),
    processImage: (dataUrl) => ipcRenderer.invoke("process-image", dataUrl),
    detectCorners: (dataUrl) => ipcRenderer.invoke("detect-corners", dataUrl),

    saveProjectFile: (data, defaultName, existingPath) => ipcRenderer.invoke("save-file-dialog", data, defaultName, existingPath),
    openProjectFile: () => ipcRenderer.invoke("open-file-dialog"),
    trashProjectFile: (filePath) => ipcRenderer.invoke("trash-project-file", filePath),

    getMailConfig: () => ipcRenderer.invoke("mail-get-config"),
    saveMailConfig: (cfg) => ipcRenderer.invoke("mail-save-config", cfg),
    getRecipients: () => ipcRenderer.invoke("mail-get-recipients"),
    saveRecipients: (list) => ipcRenderer.invoke("mail-save-recipients", list),
    sendDirectEmail: (payload) => ipcRenderer.invoke("send-email-direct", payload)
});
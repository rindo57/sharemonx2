// const { JSDOM } = require("jsdom");

// Api Functions
async function postJson(url, data) {
    data['password'] = getPassword();
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
    return await response.json();
}

// Login attempt tracking
const maxAttempts = 5;
const lockoutDuration = 60 * 60 * 1000; // 12 hours in milliseconds
const attemptsKey = "loginAttempts";
const lockoutTimeKey = "lockoutTime";

// Interaction tracking for invisible CAPTCHA
const interactionData = {
    mouseMovements: [],
    clicks: 0,
    keypresses: 0,
    touchMovements: [], // New property for touch interactions
};

function initializeAttempts() {
    const storedAttempts = localStorage.getItem(attemptsKey);
    const lockoutTime = localStorage.getItem(lockoutTimeKey);

    if (lockoutTime && Date.now() >= Number(lockoutTime)) {
        // Reset attempts if the lockout period has expired
        localStorage.removeItem(attemptsKey);
        localStorage.removeItem(lockoutTimeKey);
        return 0;
    }

    return storedAttempts ? Number(storedAttempts) : 0;
}

let attempts = initializeAttempts();

// Update attempts in localStorage
function saveAttempts(attempts) {
    localStorage.setItem(attemptsKey, attempts);

    if (attempts >= maxAttempts) {
        // Set lockout expiration time
        localStorage.setItem(lockoutTimeKey, Date.now() + lockoutDuration);
    }
}

// Track mouse movements
document.addEventListener("mousemove", (e) => {
    interactionData.mouseMovements.push({ x: e.clientX, y: e.clientY, time: Date.now() });
});

// Track button clicks
document.getElementById("pass-login").addEventListener("click", () => {
    interactionData.clicks++;
});

document.addEventListener("touchmove", (e) => {
    const touch = e.touches[0];
    interactionData.touchMovements.push({ x: touch.clientX, y: touch.clientY, time: Date.now() });
});

document.getElementById("auth-pass").addEventListener("input", () => {
    interactionData.keypresses++;
});

// Track keypresses
document.getElementById("auth-pass").addEventListener("keypress", () => {
    interactionData.keypresses++;
});

document.getElementById('pass-login').addEventListener('click', async () => {
    const loginButton = document.getElementById("pass-login");
    const password = document.getElementById('auth-pass').value;
    const errorMessage = document.getElementById('error-message');

    // Check if user is locked out
    const lockoutTime = localStorage.getItem(lockoutTimeKey);
    if (lockoutTime && Date.now() < Number(lockoutTime)) {
        errorMessage.textContent = "You are locked out. Please try again later.";
        errorMessage.style.display = "block";
        return;
    }

    if (!password) {
        alert('Please enter your password.');
        return;
    }

    const data = {
        pass: password,
        interactionData: interactionData, // Send interaction data to backend
    };

    const json = await postJson('/api/checkPassword', data);

    if (json.status === 'ok') {
        alert('Check your inbox!');
        window.location.reload();
    } else {
        attempts++;
        saveAttempts(attempts);
        if (attempts >= maxAttempts) {
            loginButton.disabled = true;
            errorMessage.style.display = "block";
        } else {
            alert(`Incorrect password. You have ${maxAttempts - attempts} attempts left.`);
        }
    }

    // Clear the password field
    document.getElementById('auth-pass').value = "";
});

function hideMoreColumnIfSharedPath() {
    // Check if the current path starts with '/share'
    if (getCurrentPath().startsWith('/share')) {
        // Select the "More" column header
        const moreColumnHeader = document.querySelector('.directory th:last-child');

        // Hide the "More" header cell
        if (moreColumnHeader) {
            moreColumnHeader.style.display = 'none';
        }

        // Select all cells in the "More" column
        const rows = document.querySelectorAll('.directory tbody tr');
        rows.forEach(row => {
            const moreColumnCell = row.querySelector('td:last-child');
            if (moreColumnCell) {
                moreColumnCell.style.display = 'none';
            }
        });
    }
}

async function getCurrentDirectory() {
    let path = getCurrentPath();
    if (path === 'redirect') {
        return;
    }
    try {
        const auth = getFolderAuthFromPath();
        const query = getFolderQueryFromPath();
        const data = { 'path': path, 'auth': auth, 'query': query };
        const json = await postJson('/api/getDirectory', data);

        if (json.status === 'ok') {
            if (getCurrentPath().startsWith('/share')) {
                const sections = document.querySelector('.sidebar-menu').getElementsByTagName('a');

                if (removeSlash(json['auth_home_path']) === removeSlash(path.split('_')[1])) {
                    sections[0].setAttribute('class', 'selected-item');
                } else {
                    sections[0].setAttribute('class', 'unselected-item');
                }
                sections[0].href = `/?path=/share_${removeSlash(json['auth_home_path'])}&auth=${auth}`;
                hideMoreColumnIfSharedPath();

                console.log(`/?path=/share_${removeSlash(json['auth_home_path'])}&auth=${auth}`)
            }
            console.log(json)
            showDirectory(json['data']);
        } else {
            alert('404 Current Directory Not Found');
        }
    }
    catch (err) {
        alert('404 Current Directory Not Found');
    }
}

async function createNewFolder() {
    const folderName = document.getElementById('new-folder-name').value;
    const path = getCurrentPath();
    if (path === 'redirect') {
        return;
    }
    if (folderName.length > 0) {
        const data = {
            'name': folderName,
            'path': path
        };
        try {
            const json = await postJson('/api/createNewFolder', data);

            if (json.status === 'ok') {
                window.location.reload();
            } else {
                alert(json.status);
            }
        }
        catch (err) {
            alert('Error Creating Folder');
        }
    } else {
        alert('Folder Name Cannot Be Empty');
    }
}

async function getFolderShareAuth(path) {
    const data = { 'path': path };
    const json = await postJson('/api/getFolderShareAuth', data);
    if (json.status === 'ok') {
        return json.auth;
    } else {
        alert('Error Getting Folder Share Auth');
    }
}

// File Uploader - Updated with proper concurrent handling
const MAX_FILE_SIZE = 2126008811.52; // Will be replaced by the python

const fileInput = document.getElementById('fileInput');
const progressBar = document.getElementById('progress-bar');
const cancelButton = document.getElementById('cancel-file-upload');
const uploadPercent = document.getElementById('upload-percent');

class UploadManager {
    constructor() {
        this.uploadQueue = [];
        this.remoteUploadQueue = [];
        this.activeUploads = 0;
        this.activeRemoteUploads = 0;
        this.maxConcurrentUploads = 1;
        this.maxRemoteConcurrentUploads = 1;
        this.currentUploads = new Map(); // Track current uploads by ID
    }

    // File upload methods
    addFiles(files) {
        for (const file of files) {
            if (file.size > MAX_FILE_SIZE) {
                alert(`File size exceeds ${(MAX_FILE_SIZE / (1024 * 1024 * 1024)).toFixed(2)} GB limit`);
                continue;
            }
            this.uploadQueue.push({
                file,
                id: this.generateId(),
                type: 'file'
            });
        }
        this.processUploadQueue();
        this.renderPendingUploadList();
    }

    processUploadQueue() {
        while (this.activeUploads < this.maxConcurrentUploads && this.uploadQueue.length > 0) {
            const uploadItem = this.uploadQueue.shift();
            this.activeUploads++;
            this.currentUploads.set(uploadItem.id, uploadItem);
            this.uploadFile(uploadItem);
        }
        
        this.checkAllUploadsComplete();
    }

    async uploadFile(uploadItem) {
        const { file, id } = uploadItem;
        const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        try {
            // Show uploader UI for first active upload
            if (this.activeUploads === 1) {
                this.showUploaderUI();
            }

            this.updateUploaderDisplay(file.name, file.size, "Uploading To Backend Server");

            const path = getCurrentPath();
            const password = getPassword();

            for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                const start = chunkIndex * CHUNK_SIZE;
                const end = Math.min(file.size, start + CHUNK_SIZE);
                const chunk = file.slice(start, end);

                const formData = new FormData();
                formData.append("file", chunk);
                formData.append("path", path);
                formData.append("password", password);
                formData.append("id", id);
                formData.append("chunkIndex", chunkIndex);
                formData.append("totalChunks", totalChunks);
                formData.append("filename", file.name);
                formData.append("filenamex", file.name);
                formData.append("total_size", file.size);

                const uploadRequest = new XMLHttpRequest();
                uploadRequest.open("POST", "/api/upload", true);
                uploadRequest.setRequestHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                uploadRequest.setRequestHeader("Pragma", "no-cache");
                uploadRequest.setRequestHeader("Expires", "0");

                uploadRequest.upload.addEventListener("progress", (e) => {
                    if (e.lengthComputable) {
                        const percentComplete = ((chunkIndex + e.loaded / e.total) / totalChunks) * 100;
                        // Only update progress if this is the current active upload being displayed
                        if (this.getCurrentDisplayedUpload()?.id === id) {
                            progressBar.style.width = percentComplete + "%";
                            uploadPercent.innerText = "Progress: " + percentComplete.toFixed(2) + "%";
                        }
                    }
                });

                await new Promise((resolve, reject) => {
                    uploadRequest.onload = () => {
                        if (uploadRequest.status === 200) {
                            resolve();
                        } else {
                            reject(`Chunk ${chunkIndex + 1} failed to upload`);
                        }
                    };

                    uploadRequest.onerror = () =>
                        reject(`Network error while uploading chunk ${chunkIndex + 1}`);
                    uploadRequest.send(formData);
                });
            }

            await this.updateSaveProgress(id);
            
        } catch (error) {
            console.error('Upload failed:', error);
            alert(`Upload failed: ${error}`);
        } finally {
            this.activeUploads--;
            this.currentUploads.delete(id);
            this.processUploadQueue();
            this.renderPendingUploadList();
        }
    }

    getCurrentDisplayedUpload() {
        // Return the first upload in progress for display purposes
        if (this.currentUploads.size > 0) {
            return this.currentUploads.values().next().value;
        }
        return null;
    }

    // Remote URL upload methods
    addRemoteFiles(fileInfoArray) {
        for (const fileInfo of fileInfoArray) {
            this.remoteUploadQueue.push({
                ...fileInfo,
                id: this.generateId(),
                type: 'remote'
            });
        }
        this.processRemoteUploadQueue();
        this.renderPendingRemoteUploadList();
    }

    processRemoteUploadQueue() {
        while (this.activeRemoteUploads < this.maxRemoteConcurrentUploads && this.remoteUploadQueue.length > 0) {
            const uploadItem = this.remoteUploadQueue.shift();
            this.activeRemoteUploads++;
            this.currentUploads.set(uploadItem.id, uploadItem);
            this.download_progress_updater(uploadItem);
        }
        
        this.checkAllUploadsComplete();
    }

    async download_progress_updater(uploadItem) {
        const { file_urlx, file_name, file_size, singleThreaded, id } = uploadItem;

        try {
            // Show uploader UI for first active remote upload
            if (this.activeRemoteUploads === 1 && this.activeUploads === 0) {
                this.showUploaderUI();
            }

            this.updateUploaderDisplay(file_name, file_size, "Downloading File From Url To Backend Server");

            const downloadId = await start_file_download_from_url(file_urlx, file_name, singleThreaded);

            const interval = setInterval(async () => {
                const response = await postJson('/api/getFileDownloadProgress', { 'id': downloadId });
                const data = response['data'];

                if (data[0] === 'error') {
                    clearInterval(interval);
                    throw new Error('Failed to download file from URL to backend server');
                } else if (data[0] === 'completed') {
                    clearInterval(interval);
                    if (this.getCurrentDisplayedUpload()?.id === id) {
                        uploadPercent.innerText = 'Progress : 100%';
                        progressBar.style.width = '100%';
                    }
                    await this.handleUpload3(downloadId, id);
                } else {
                    const current = data[1];
                    const total = data[2];
                    const percentComplete = (current / total) * 100;
                    
                    if (this.getCurrentDisplayedUpload()?.id === id) {
                        progressBar.style.width = percentComplete + '%';
                        uploadPercent.innerText = 'Progress : ' + percentComplete.toFixed(2) + '%';
                        
                        if (data[0] === 'Downloading') {
                            this.updateUploaderDisplay(file_name, file_size, 'Status: Downloading File From Url To Backend Server');
                        } else {
                            this.updateUploaderDisplay(file_name, file_size, `Status: ${data[0]}`);
                        }
                    }
                }
            }, 3000);

        } catch (error) {
            console.error('Remote upload failed:', error);
            alert(`Remote upload failed: ${error}`);
        } finally {
            // Note: activeRemoteUploads is decremented in handleUpload3
        }
    }

    async handleUpload3(uploadId, originalId) {
        if (this.getCurrentDisplayedUpload()?.id === originalId) {
            this.updateUploaderDisplay(
                this.getCurrentDisplayedUpload()?.file_name || 'Unknown',
                this.getCurrentDisplayedUpload()?.file_size || 0,
                'Status: Uploading To Telegram Server'
            );
            progressBar.style.width = '0%';
            uploadPercent.innerText = 'Progress : 0%';
        }

        const interval = setInterval(async () => {
            const response = await postJson('/api/getUploadProgress', { 'id': uploadId });
            const data = response['data'];
            
            if (data[0] === 'running') {
                const current = data[1];
                const total = data[2];
                
                if (this.getCurrentDisplayedUpload()?.id === originalId) {
                    this.updateUploaderDisplay(
                        this.getCurrentDisplayedUpload()?.file_name || 'Unknown',
                        total,
                        'Status: Uploading To Telegram Server'
                    );

                    let percentComplete = total === 0 ? 0 : (current / total) * 100;
                    progressBar.style.width = percentComplete + '%';
                    uploadPercent.innerText = 'Progress : ' + percentComplete.toFixed(2) + '%';
                }
            } else if (data[0] === 'completed') {
                clearInterval(interval);
                this.activeRemoteUploads--;
                this.currentUploads.delete(originalId);
                this.processRemoteUploadQueue();
                this.renderPendingRemoteUploadList();
            }
        }, 3000);
    }

    async updateSaveProgress(id) {
        if (this.getCurrentDisplayedUpload()?.id === id) {
            progressBar.style.width = '0%';
            uploadPercent.innerText = 'Progress : 0%';
            this.updateUploaderDisplay(
                this.getCurrentDisplayedUpload()?.file_name || 'Unknown',
                this.getCurrentDisplayedUpload()?.file_size || 0,
                'Status: Processing File On Backend Server'
            );
        }

        const interval = setInterval(async () => {
            const response = await postJson('/api/getSaveProgress', { 'id': id });
            const data = response['data'];

            if (data[0] === 'running') {
                const current = data[1];
                const total = data[2];
                
                if (this.getCurrentDisplayedUpload()?.id === id) {
                    this.updateUploaderDisplay(
                        this.getCurrentDisplayedUpload()?.file_name || 'Unknown',
                        total,
                        'Status: Processing File On Backend Server'
                    );

                    const percentComplete = (current / total) * 100;
                    progressBar.style.width = percentComplete + '%';
                    uploadPercent.innerText = 'Progress : ' + percentComplete.toFixed(2) + '%';
                }
            } else if (data[0] === 'completed') {
                clearInterval(interval);
                if (this.getCurrentDisplayedUpload()?.id === id) {
                    uploadPercent.innerText = 'Progress : 100%';
                    progressBar.style.width = '100%';
                }
            }
        }, 3000);
    }

    // UI Management
    showUploaderUI() {
        document.getElementById("bg-blur").style.zIndex = "2";
        document.getElementById("bg-blur").style.opacity = "0.1";
        document.getElementById("file-uploader").style.zIndex = "3";
        document.getElementById("file-uploader").style.opacity = "1";
    }

    hideUploaderUI() {
        document.getElementById("bg-blur").style.zIndex = "-1";
        document.getElementById("bg-blur").style.opacity = "0";
        document.getElementById("file-uploader").style.zIndex = "-1";
        document.getElementById("file-uploader").style.opacity = "0";
    }

    updateUploaderDisplay(filename, filesize, status) {
        const currentUpload = this.getCurrentDisplayedUpload();
        if (currentUpload) {
            document.getElementById("upload-filename").innerText = "Filename: " + filename;
            document.getElementById("upload-filesize").innerText = "Filesize: " + (filesize / (1024 * 1024)).toFixed(2) + " MB";
            document.getElementById("upload-status").innerText = status;
        }
    }

    // Queue management
    removeFile(fileToRemove) {
        this.uploadQueue = this.uploadQueue.filter(item => item.file.name !== fileToRemove.name);
        this.renderPendingUploadList();
    }

    removeRemoteFile(fileToRemove) {
        this.remoteUploadQueue = this.remoteUploadQueue.filter(item => item.file_name !== fileToRemove.file_name);
        this.renderPendingRemoteUploadList();
    }

    renderPendingUploadList() {
        const pendingFilesList = document.getElementById('pending-files');
        const pendingHeading = document.getElementById('pending-heading');
        const pendingUploadListContainer = document.getElementById('Pending-upload-list');

        pendingFilesList.innerHTML = '';

        const pendingFiles = [...this.uploadQueue, ...this.remoteUploadQueue];

        if (pendingFiles.length > 0) {
            pendingHeading.style.display = 'block';
            pendingFilesList.style.display = 'block';
            pendingUploadListContainer.style.border = '1px solid #ccc';
        } else {
            pendingHeading.style.display = 'none';
            pendingFilesList.style.display = 'none';
            pendingUploadListContainer.style.border = 'none';
        }

        pendingFiles.forEach(item => {
            const listItem = document.createElement('li');
            listItem.style.display = 'flex';
            listItem.style.justifyContent = 'space-between';
            listItem.style.alignItems = 'center';
            listItem.style.marginBottom = '5px';
            listItem.style.flexWrap = 'nowrap';

            const fileNameSpan = document.createElement('span');
            fileNameSpan.textContent = `📁 ${item.file?.name || item.file_name}`;
            fileNameSpan.style.overflow = 'hidden';
            fileNameSpan.style.textOverflow = 'ellipsis';
            fileNameSpan.style.whiteSpace = 'nowrap';
            fileNameSpan.style.flexGrow = '1';
            fileNameSpan.style.marginRight = '10px';
            fileNameSpan.style.maxWidth = '300px';

            const removeButton = document.createElement('button');
            removeButton.textContent = '❌';
            removeButton.onclick = () => {
                if (item.type === 'file') {
                    this.removeFile(item);
                } else {
                    this.removeRemoteFile(item);
                }
            };

            listItem.appendChild(fileNameSpan);
            listItem.appendChild(removeButton);
            pendingFilesList.appendChild(listItem);
        });
    }

    renderPendingRemoteUploadList() {
        // Combined with renderPendingUploadList now
        this.renderPendingUploadList();
    }

    checkAllUploadsComplete() {
        if (this.activeUploads === 0 && this.activeRemoteUploads === 0 && 
            this.uploadQueue.length === 0 && this.remoteUploadQueue.length === 0) {
            setTimeout(() => {
                alert('All uploads completed boss! 😎');
                this.hideUploaderUI();
                window.location.reload();
            }, 1000);
        }
    }

    generateId() {
        return Math.random().toString(36).substr(2, 9);
    }
}

// Initialize upload manager
const uploadManager = new UploadManager();

// Event listeners
fileInput.addEventListener('change', async (e) => {
    const files = fileInput.files;
    uploadManager.addFiles(Array.from(files));
});

cancelButton.addEventListener('click', () => {
    alert('Upload canceled');
    window.location.reload();
});

// URL Uploader Functions
async function get_file_info_from_url(url) {
    const data = { 'url': url }
    const json = await postJson('/api/getFileInfoFromUrl', data)
    if (json.status === 'ok') {
        return json.data
    } else {
        throw new Error(`Error Getting File Info : ${json.status}`)
    }
}

async function start_file_download_from_url(url, filename, singleThreaded = true) {
    const data = { 'url': url, 'path': getCurrentPath(), 'filename': filename, 'singleThreaded': singleThreaded }
    const json = await postJson('/api/startFileDownloadFromUrl', data)
    if (json.status === 'ok') {
        return json.id
    } else {
        throw new Error(`Error Starting File Download : ${json.status}`)
    }
}

async function Start_URL_Upload() {
    try {
        document.getElementById('new-url-upload').style.opacity = '0';
        setTimeout(() => {
            document.getElementById('new-url-upload').style.zIndex = '-1';
        }, 300)
        
        const file_url = document.getElementById('remote-url').value
        const singleThreaded = true

        const file_info = await get_file_info_from_url(file_url);
        uploadManager.addRemoteFiles(file_info.map(info => ({
            file_urlx: info.file_url,
            file_name: info.file_name,
            file_size: info.file_size,
            singleThreaded: singleThreaded
        })));
    }
    catch (err) {
        alert("Error: " + err.message);
        window.location.reload();
    }
}

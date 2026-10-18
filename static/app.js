
"use strict";

const $ = (id) => document.getElementById(id);

const elements = {
    form: $("uploadForm"),
    file: $("audioFile"),
    dropZone: $("dropZone"),
    fileName: $("fileName"),
    fileDescription: $("fileDescription"),
    uploadButton: $("uploadButton"),
    statusPanel: $("statusPanel"),
    statusTitle: $("statusTitle"),
    statusMessage: $("statusMessage"),
    progressBar: $("progressBar"),
    progressPercent: $("progressPercent"),
    resultsSection: $("resultsSection"),
    tracks: $("tracksContainer"),
    trackTitle: $("trackTitle"),
    trackSummary: $("trackSummary"),
    playerSubtitle: $("playerSubtitle"),
    playPause: $("playPauseButton"),
    playIcon: $("playIcon"),
    pauseIcon: $("pauseIcon"),
    currentTime: $("currentTime"),
    duration: $("duration"),
    timeline: $("masterTimeline"),
    timelineFill: $("masterTimelineFill"),
    playhead: $("masterPlayhead"),
    playbackStatus: $("playbackStatus"),
    download: $("downloadZipButton"),
    settingsToggle: $("settingsToggle"),
    settingsPanel: $("settingsPanel"),
    settingsClose: $("settingsClose"),
    saveSettings: $("saveSettings"),
    resetSettings: $("resetSettings"),
    settingsFeedback: $("settingsFeedback"),
    waveEffect: $("waveEffectEnabled")
};

const defaults = {
    backgroundColor: "#19191f",
    accentColor: "#ff80c8",
    playedColor: "#b45cff",
    unplayedColor: "#454550",
    gradientStart: "#19191f",
    gradientEnd: "#ff4545",
    leadColor: "#ff80c8",
    backColor: "#b45cff",
    adlibsColor: "#ff6868",
    instrumentalColor: "#67d8c5",
    waveEffectEnabled: true
};

const colorSettings = [
    "backgroundColor",
    "accentColor",
    "playedColor",
    "unplayedColor",
    "gradientStart",
    "gradientEnd",
    "leadColor",
    "backColor",
    "adlibsColor",
    "instrumentalColor"
];

const tracks = [];
let currentJobId = null;
let pollTimer = null;
let animationFrame = null;
let audioContext = null;
let isPlaying = false;
let masterDuration = 0;
let masterTime = 0;
let soloTrack = null;
let decorativeCanvas = null;
let decorativeFrame = null;

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

function setStatus(title, message, progress) {
    elements.statusTitle.textContent = title;
    elements.statusMessage.textContent = message;
    elements.progressPercent.textContent = `${progress}%`;
    elements.progressBar.style.width = `${progress}%`;
}

function setBusy(busy) {
    elements.uploadButton.disabled = busy || !elements.file.files.length;
    elements.file.disabled = busy;
    elements.uploadButton.querySelector("span:first-child").textContent =
        busy ? "Processing..." : "Separate audio";
}

function showError(message) {
    elements.statusPanel.hidden = false;
    elements.statusTitle.textContent = "Something went wrong";
    elements.statusMessage.textContent = message;
    elements.progressBar.style.width = "0%";
    elements.progressPercent.textContent = "!";
    setBusy(false);
}

function friendlyError(message) {
    if (typeof message !== "string") return "An unexpected error occurred.";
    return message.slice(0, 1200);
}

/* -----------------------------------------
   File selection and upload
----------------------------------------- */

elements.file.addEventListener("change", () => {
    const file = elements.file.files[0];

    if (!file) {
        elements.fileName.textContent = "Drop your audio here";
        elements.fileDescription.textContent = "or click to browse your files";
        elements.uploadButton.disabled = true;
        return;
    }

    if (file.size > 200 * 1024 * 1024) {
        elements.file.value = "";
        elements.fileName.textContent = "File is too large";
        elements.fileDescription.textContent = "Choose an audio file under 200 MB.";
        elements.uploadButton.disabled = true;
        return;
    }

    elements.fileName.textContent = file.name;
    elements.fileDescription.textContent =
        `${(file.size / (1024 * 1024)).toFixed(1)} MB · Ready to import`;
    elements.uploadButton.disabled = false;
});

["dragenter", "dragover"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.add("drag-over");
    });
});

["dragleave", "drop"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.remove("drag-over");
    });
});

elements.dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    const allowed = /\.(wav|mp3|flac|ogg|m4a)$/i.test(file.name);
    if (!allowed) {
        elements.fileDescription.textContent = "Choose WAV, MP3, FLAC, OGG or M4A.";
        return;
    }

    const transfer = new DataTransfer();
    transfer.items.add(file);
    elements.file.files = transfer.files;
    elements.file.dispatchEvent(new Event("change"));
});

elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = elements.file.files[0];
    if (!file) return;

    if (file.size > 200 * 1024 * 1024) {
        showError("File is too large. The maximum upload size is 200 MB.");
        return;
    }

    stopAllAudio();
    clearTracks();

    if (pollTimer) clearTimeout(pollTimer);

    elements.statusPanel.hidden = false;
    elements.resultsSection.hidden = true;
    elements.download.hidden = true;
    setBusy(true);
    setStatus("Uploading your track...", "Sending audio to the local server.", 5);

    const formData = new FormData();
    formData.append("audio", file);

    try {
        const response = await fetch("/api/separate", {
            method: "POST",
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Upload failed.");
        }

        currentJobId = data.job_id;
        setStatus("AI is preparing your track...", "This may take a little while.", 10);
        pollStatus();
    } catch (error) {
        showError(friendlyError(error.message));
    }
});

async function pollStatus() {
    if (!currentJobId) return;

    try {
        const response = await fetch(`/api/status/${encodeURIComponent(currentJobId)}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Could not check processing status.");
        }

        const progress = Number.isFinite(data.progress) ? data.progress : 0;
        setStatus(
            data.status === "complete" ? "Separation complete!" :
            data.status === "error" ? "Separation failed" :
            "AI is separating your audio...",
            data.message || "Processing...",
            progress
        );

        if (data.status === "complete") {
            elements.statusTitle.textContent = "Your stems are ready";
            elements.resultsSection.hidden = false;
            elements.download.hidden = false;
            elements.download.onclick = () => {
                window.location.href = data.zip_url;
            };

            elements.trackTitle.textContent =
                elements.file.files[0]?.name || "Your track";
            elements.trackSummary.textContent =
                `${data.stems.length} separated audio files`;
            elements.playerSubtitle.textContent = "Separated audio stems";

            await buildTracks(data.stems || []);
            setBusy(false);
            return;
        }

        if (data.status === "error") {
            showError(friendlyError(data.message || "Separation failed."));
            return;
        }

        pollTimer = setTimeout(pollStatus, 1500);
    } catch (error) {
        showError(friendlyError(error.message));
    }
}

/* -----------------------------------------
   Track player and synchronized timeline
----------------------------------------- */

function clearTracks() {
    stopAllAudio();
    tracks.forEach((track) => {
        track.audio.pause();
        track.audio.removeAttribute("src");
        track.audio.load();
    });
    tracks.length = 0;
    elements.tracks.replaceChildren();
    masterDuration = 0;
    masterTime = 0;
    soloTrack = null;
    updateMasterUI();
}

function stopAllAudio() {
    isPlaying = false;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;

    tracks.forEach((track) => {
        track.audio.pause();
    });

    elements.playIcon.hidden = false;
    elements.pauseIcon.hidden = true;
    elements.playbackStatus.textContent = "READY TO PLAY";
}

function displayTrackName(name) {
    const names = {
        vocals: "Vocals",
        drums: "Drums",
        bass: "Bass",
        other: "Other / Instrumental Parts"
    };
    return names[name] || name.replace(/[_-]/g, " ");
}

function getTrackColor(name) {
    if (name === "vocals") return getSetting("leadColor");
    if (name === "drums") return getSetting("backColor");
    if (name === "bass") return getSetting("adlibsColor");
    return getSetting("instrumentalColor");
}

async function buildTracks(stems) {
    clearTracks();

    if (!stems.length) {
        elements.tracks.textContent = "No separated audio files were returned.";
        return;
    }

    for (const stem of stems) {
        const audio = new Audio();
        audio.preload = "metadata";
        audio.src = stem.url;
        audio.crossOrigin = "same-origin";

        const track = {
            name: stem.name,
            label: displayTrackName(stem.name),
            audio,
            canvas: null,
            ctx: null,
            peaks: [],
            color: getTrackColor(stem.name),
            muted: false,
            volume: 1,
            ready: false
        };

        tracks.push(track);
        createTrackUI(track);

        audio.addEventListener("loadedmetadata", () => {
            track.ready = true;
            masterDuration = Math.max(masterDuration, audio.duration || 0);
            elements.duration.textContent = formatTime(masterDuration);
            updateMasterUI();
        });

        audio.addEventListener("ended", () => {
            if (tracks.every((item) =>
                item.audio.ended || item.audio.paused
            )) {
                isPlaying = false;
                elements.playIcon.hidden = false;
                elements.pauseIcon.hidden = true;
                elements.playbackStatus.textContent = "PLAYBACK ENDED";
            }
        });

        audio.addEventListener("error", () => {
            elements.playbackStatus.textContent = "A TRACK COULD NOT LOAD";
        });

        drawPlaceholder(track);
        createPeaks(track).then(() => {
            drawWaveform(track);
        }).catch(() => {
            drawPlaceholder(track);
        });
    }

    elements.resultsSection.hidden = false;
    elements.playbackStatus.textContent = "READY TO PLAY";
    updateMasterUI();
}

function createTrackUI(track) {
    const row = document.createElement("article");
    row.className = "track-row";
    row.style.setProperty("--track-color", track.color);

    const header = document.createElement("div");
    header.className = "track-row-header";

    const nameGroup = document.createElement("div");
    nameGroup.className = "track-name-group";

    const dot = document.createElement("span");
    dot.className = "track-color-dot";

    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = track.label;

    nameGroup.append(dot, name);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    const muteButton = makeTrackButton("Mute track", "M");
    const soloButton = makeTrackButton("Solo track", "S");

    const volume = document.createElement("input");
    volume.className = "track-volume";
    volume.type = "range";
    volume.min = "0";
    volume.max = "1";
    volume.step = "0.01";
    volume.value = "1";
    volume.setAttribute("aria-label", `${track.label} volume`);

    muteButton.addEventListener("click", () => {
        track.muted = !track.muted;
        muteButton.classList.toggle("active", track.muted);
        muteButton.setAttribute("aria-pressed", String(track.muted));
        applyVolumes();
    });

    soloButton.addEventListener("click", () => {
        soloTrack = soloTrack === track ? null : track;
        tracks.forEach((item) => {
            const button = item.soloButton;
            if (button) {
                button.classList.toggle("active", soloTrack === item);
                button.setAttribute("aria-pressed", String(soloTrack === item));
            }
        });
        applyVolumes();
    });

    volume.addEventListener("input", () => {
        track.volume = Number(volume.value);
        applyVolumes();
    });

    track.soloButton = soloButton;
    actions.append(muteButton, soloButton, volume);
    header.append(nameGroup, actions);

    const waveform = document.createElement("div");
    waveform.className = "track-waveform";
    waveform.setAttribute("role", "slider");
    waveform.setAttribute("tabindex", "0);
    waveform.setAttribute("aria-label", `${track.label} waveform; seek audio`);

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    waveform.append(canvas);

    const playhead = document.createElement("div");
    playhead.className = "track-playhead";
    waveform.append(playhead);

    track.canvas = canvas;
    track.ctx = canvas.getContext("2d");
    track.playhead = playhead;
    track.waveform = waveform;

    waveform.addEventListener("click", (event) => {
        const rect = waveform.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        seekTo(ratio * masterDuration);
    });

    waveform.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const delta = event.key === "ArrowRight" ? 5 : -5;
            seekTo(Math.max(0, Math.min(masterDuration, masterTime + delta)));
        } else if (event.key === "Home") {
            seekTo(0);
        } else if (event.key === "End") {
            seekTo(masterDuration);
        }
    });

    row.append(header, waveform);
    elements.tracks.append(row);
}

function makeTrackButton(label, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-action";
    button.textContent = text;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", "false");
    return button;
}

function applyVolumes() {
    tracks.forEach((track) => {
        const soloAllows = soloTrack === null || soloTrack === track;
        track.audio.volume = track.muted || !soloAllows ? 0 : track.volume;
    });
}

async function togglePlayback() {
    if (!tracks.length) return;

    if (isPlaying) {
        tracks.forEach((track) => track.audio.pause());
        isPlaying = false;
        elements.playIcon.hidden = false;
        elements.pauseIcon.hidden = true;
        elements.playbackStatus.textContent = "PAUSED";
        return;
    }

    if (masterDuration && masterTime >= masterDuration) {
        seekTo(0);
    }

    applyVolumes();

    try {
        await Promise.all(tracks.map(async (track) => {
            if (Math.abs(track.audio.currentTime - masterTime) > 0.15) {
                track.audio.currentTime = masterTime;
            }
            await track.audio.play();
        }));

        isPlaying = true;
        elements.playIcon.hidden = true;
        elements.pauseIcon.hidden = false;
        elements.playbackStatus.textContent = "PLAYING";
        startPlaybackLoop();
    } catch (error) {
        tracks.forEach((track) => track.audio.pause());
        isPlaying = false;
        elements.playbackStatus.textContent = "PLAYBACK ERROR";
        console.error("Playback error:", error);
    }
}

function startPlaybackLoop() {
    if (animationFrame) cancelAnimationFrame(animationFrame);

    const update = () => {
        if (!isPlaying) return;

        const activeTrack = tracks.find((track) => !track.audio.paused);
        if (activeTrack) {
            masterTime = activeTrack.audio.currentTime || 0;

            tracks.forEach((track) => {
                if (track.audio.paused && !track.audio.ended) {
                    try {
                        track.audio.currentTime = masterTime;
                        track.audio.play().catch(() => {});
                    } catch (_) {}
                }
            });
        }

        updateMasterUI();
        tracks.forEach(drawWaveform);
        animationFrame = requestAnimationFrame(update);
    };

    animationFrame = requestAnimationFrame(update);
}

function seekTo(time) {
    masterTime = Math.max(0, Math.min(masterDuration || 0, time || 0));

    tracks.forEach((track) => {
        if (Number.isFinite(track.audio.duration)) {
            try {
                track.audio.currentTime = Math.min(masterTime, track.audio.duration);
            } catch (_) {}
        }
    });

    updateMasterUI();
    tracks.forEach(drawWaveform);
}

function updateMasterUI() {
    const ratio = masterDuration > 0 ? masterTime / masterDuration : 0;
    const percent = `${Math.max(0, Math.min(100, ratio * 100))}%`;

    elements.currentTime.textContent = formatTime(masterTime);
    elements.duration.textContent = formatTime(masterDuration);
    elements.timelineFill.style.width = percent;
    elements.playhead.style.left = percent;
    elements.timeline.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));

    tracks.forEach((track) => {
        if (track.playhead) track.playhead.style.left = percent;
    });
}

elements.playPause.addEventListener("click", togglePlayback);

elements.timeline.addEventListener("click", (event) => {
    const rect = elements.timeline.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekTo(ratio * masterDuration);
});

elements.timeline.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        seekTo(Math.max(0, Math.min(
            masterDuration,
            masterTime + (event.key === "ArrowRight" ? 5 : -5)
        )));
    } else if (event.key === "Home") {
        seekTo(0);
    } else if (event.key === "End") {
        seekTo(masterDuration);
    }
});

/* -----------------------------------------
   Real waveform rendering
----------------------------------------- */

function getAudioContext() {
    if (!audioContext) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error("Web Audio is not supported by this browser.");
        audioContext = new Context();
    }
    return audioContext;
}

async function createPeaks(track) {
    const response = await fetch(track.audio.src);
    if (!response.ok) throw new Error("Could not load audio for waveform.");

    const buffer = await response.arrayBuffer();
    const context = getAudioContext();
    const decoded = await context.decodeAudioData(buffer);

    const channel = decoded.getChannelData(0);
    const barCount = 1200;
    const samplesPerBar = Math.max(1, Math.floor(channel.length / barCount));
    const peaks = [];

    for (let start = 0; start < channel.length; start += samplesPerBar) {
        let peak = 0;
        const end = Math.min(channel.length, start + samplesPerBar);

        for (let i = start; i < end; i++) {
            peak = Math.max(peak, Math.abs(channel[i]));
        }

        peaks.push(peak);
    }

    track.peaks = peaks;
    track.waveDuration = decoded.duration;
}

function drawPlaceholder(track) {
    if (!track.canvas || !track.ctx) return;
    drawWaveform(track, true);
}

function drawWaveform(track, placeholder = false) {
    if (!track.canvas || !track.ctx) return;

    const canvas = track.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }

    const ctx = track.ctx;
    ctx.clearRect(0, 0, width, height);

    const peaks = track.peaks;
    const count = Math.max(1, Math.floor(rect.width / 3));
    const gap = 1.5 * dpr;
    const barWidth = Math.max(1, (width - gap * count) / count);
    const playedRatio = masterDuration > 0
        ? Math.min(1, masterTime / masterDuration)
        : 0;

    const playedColor = getSetting("playedColor");
    const unplayedColor = getSetting("unplayedColor");

    for (let i = 0; i < count; i++) {
        let peak;

        if (peaks.length && !placeholder) {
            const index = Math.min(
                peaks.length - 1,
                Math.floor((i / count) * peaks.length)
            );
            peak = peaks[index];
        } else {
            peak = 0.15 + 0.65 * Math.abs(
                Math.sin(i * 0.21 + track.name.length) *
                Math.cos(i * 0.071)
            );
        }

        const barHeight = Math.max(2 * dpr, peak * height * 0.9);
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;
        const ratio = i / count;

        ctx.fillStyle = ratio <= playedRatio ? playedColor : unplayedColor;
        ctx.globalAlpha = ratio <= playedRatio ? 1 : 0.88;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
        ctx.fill();
    }

    ctx.globalAlpha = 1;
}

/* -----------------------------------------
   Appearance settings
----------------------------------------- */

function getSetting(id) {
    const input = $(id);
    if (!input) return defaults[id];
    return input.type === "checkbox" ? input.checked : input.value;
}

function validHex(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value);
}

function applyAppearance() {
    const root = document.documentElement;

    const cssVariables = {
        backgroundColor: "--bg",
        accentColor: "--accent",
        playedColor: "--played-wave",
        unplayedColor: "--unplayed-wave",
        gradientStart: "--gradient-start",
        gradientEnd: "--gradient-end",
        leadColor: "--lead-color",
        backColor: "--back-color",
        adlibsColor: "--adlibs-color",
        instrumentalColor: "--instrumental-color"
    };

    Object.entries(cssVariables).forEach(([id, variable]) => {
        const value = getSetting(id);
        if (validHex(value)) root.style.setProperty(variable, value);
    });

    const bg = getSetting("backgroundColor");
    if (validHex(bg)) {
        root.style.setProperty("--bg-deep", shadeColor(bg, -12));
        document.body.style.backgroundColor = bg;
    }

    tracks.forEach((track) => {
        track.color = getTrackColor(track.name);
        const row = track.canvas?.closest(".track-row");
        row?.style.setProperty("--track-color", track.color);
        drawWaveform(track);
    });

    updateDecorativeWave();
}

function shadeColor(hex, amount) {
    if (!validHex(hex)) return "#141419";
    const num = parseInt(hex.slice(1), 16);
    const clamp = (n) => Math.max(0, Math.min(255, n));
    const r = clamp(((num >> 16) & 255) + amount);
    const g = clamp(((num >> 8) & 255) + amount);
    const b = clamp((num & 255) + amount);
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function loadSettings() {
    let saved = {};

    try {
        saved = JSON.parse(localStorage.getItem("vocalStudioSettings") || "{}");
    } catch (_) {}

    Object.entries(defaults).forEach(([id, defaultValue]) => {
        const input = $(id);
        if (!input) return;

        const value = Object.prototype.hasOwnProperty.call(saved, id)
            ? saved[id]
            : defaultValue;

        if (input.type === "checkbox") {
            input.checked = Boolean(value);
        } else if (validHex(value)) {
            input.value = value;
        }

        const textInput = $(`${id}Text`);
        if (textInput && input.type === "color") {
            textInput.value = input.value;
        }
    });

    applyAppearance();
}

colorSettings.forEach((id) => {
    const colorInput = $(id);
    const textInput = $(`${id}Text`);

    colorInput?.addEventListener("input", () => {
        if (textInput) textInput.value = colorInput.value;
        applyAppearance();
    });

    textInput?.addEventListener("change", () => {
        const value = textInput.value.trim();
        if (!validHex(value)) {
            textInput.value = colorInput.value;
            return;
        }
        colorInput.value = value;
        applyAppearance();
    });
});

[
    "waveEffectEnabled"
].forEach((id) => {
    $(id)?.addEventListener("change", updateDecorativeWave);
});

elements.settingsToggle.addEventListener("click", () => {
    const opening = elements.settingsPanel.hidden;
    elements.settingsPanel.hidden = !opening;
    elements.settingsToggle.setAttribute("aria-expanded", String(opening));
    if (opening) {
        elements.settingsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
});

elements.settingsClose.addEventListener("click", () => {
    elements.settingsPanel.hidden = true;
    elements.settingsToggle.setAttribute("aria-expanded", "false");
});

elements.saveSettings.addEventListener("click", () => {
    const settings = {};

    Object.keys(defaults).forEach((id) => {
        settings[id] = getSetting(id);
    });

    try {
        localStorage.setItem("vocalStudioSettings", JSON.stringify(settings));
        elements.settingsFeedback.textContent = "Appearance saved on this browser.";
    } catch (_) {
        elements.settingsFeedback.textContent = "Appearance applied, but could not be saved.";
    }

    applyAppearance();
});

elements.resetSettings.addEventListener("click", () => {
    Object.entries(defaults).forEach(([id, value]) => {
        const input = $(id);
        if (!input) return;

        if (input.type === "checkbox") {
            input.checked = value;
        } else {
            input.value = value;
        }

        const textInput = $(`${id}Text`);
        if (textInput && input.type === "color") textInput.value = value;
    });

    try {
        localStorage.removeItem("vocalStudioSettings");
    } catch (_) {}

    elements.settingsFeedback.textContent = "Default appearance restored.";
    applyAppearance();
});

/* -----------------------------------------
   Decorative gradient wave
----------------------------------------- */

function createDecorativeWave() {
    const section = document.querySelector(".welcome-section");
    if (!section) return;

    decorativeCanvas = document.createElement("canvas");
    decorativeCanvas.className = "decorative-wave-canvas";
    decorativeCanvas.setAttribute("aria-hidden", "true");

    Object.assign(decorativeCanvas.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity: "0.3",
        zIndex: "0"
    });

    section.style.overflow = "hidden";
    section.insertBefore(decorativeCanvas, section.firstChild);

    Array.from(section.children).forEach((child) => {
        if (child !== decorativeCanvas) {
            child.style.position = "relative";
            child.style.zIndex = "1";
        }
    });

    updateDecorativeWave();
}

function updateDecorativeWave() {
    const enabled = elements.waveEffect?.checked ?? true;

    if (!decorativeCanvas) return;
    decorativeCanvas.style.display = enabled ? "block" : "none";

    if (!enabled) {
        if (decorativeFrame) cancelAnimationFrame(decorativeFrame);
        decorativeFrame = null;
        return;
    }

    if (decorativeFrame) cancelAnimationFrame(decorativeFrame);

    const ctx = decorativeCanvas.getContext("2d");
    const rect = decorativeCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    decorativeCanvas.width = Math.round(rect.width * dpr);
    decorativeCanvas.height = Math.round(rect.height * dpr);

    const width = decorativeCanvas.width;
    const height = decorativeCanvas.height;
    let phase = 0;

    const draw = () => {
        ctx.clearRect(0, 0, width, height);

        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, getSetting("gradientStart"));
        gradient.addColorStop(1, getSetting("gradientEnd"));

        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1.5 * dpr;

        for (let line = 0; line < 5; line++) {
            ctx.globalAlpha = 0.22 - line * 0.025;
            ctx.beginPath();

            for (let x = 0; x <= width; x += 4 * dpr) {
                const y = height * 0.52
                    + Math.sin(x * 0.008 + phase + line * 0.45) * (12 + line * 3) * dpr
                    + Math.sin(x * 0.017 - phase * 0.6) * 7 * dpr;

                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }

            ctx.stroke();
        }

        ctx.globalAlpha = 1;
        phase += 0.012;
        decorativeFrame = requestAnimationFrame(draw);
    };

    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        draw();
    } else {
        phase = 0;
        ctx.strokeStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(0, height * 0.52);
        ctx.lineTo(width, height * 0.52);
        ctx.stroke();
    }
}

window.addEventListener("resize", () => {
    tracks.forEach(drawWaveform);
    updateDecorativeWave();
});

/* Initialize */

loadSettings();
createDecorativeWave();
